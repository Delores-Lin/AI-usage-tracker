import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppServerClient } from './codex/AppServerClient.js';
import { normalizeRateLimits } from './codex/normalize.js';
import type { RateLimitWindow } from './types.js';

interface AccountResponse { userId?: unknown; workspaceRouting?: { chatgptAccountId?: unknown } | null }
interface RateResponse { accountId?: unknown }
interface Observation { observedAt: number; accountKey: string | null }
interface Sample { observedAt: number; usedPercent: number; resetsAt: number }
interface LocalEvent { observedAt: number; totalTokens: number }
interface AccountClient {
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  stop(): void;
}

/** Never guess identity based on the session creator or the current login at scan time. */
export function verifiedIdentity(before: unknown, rate: unknown, after: unknown): { userId: string; accountId: string } | null {
  const a = before as AccountResponse | null;
  const b = after as AccountResponse | null;
  const r = rate as RateResponse | null;
  const user = a?.userId;
  const workspace = a?.workspaceRouting?.chatgptAccountId;
  if (typeof user !== 'string' || !user || typeof workspace !== 'string' || !workspace) return null;
  if (b?.userId !== user || b?.workspaceRouting?.chatgptAccountId !== workspace || r?.accountId !== workspace) return null;
  return { userId: user, accountId: workspace };
}

function localSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, '.account-identity-key');
  try {
    const data = fs.readFileSync(file);
    if (data.length !== 32) throw new Error('Account identity key is invalid');
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const data = crypto.randomBytes(32);
    try { fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' }); return data; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fs.readFileSync(file); throw e; }
  }
}

/** Estimate only within short, consecutive observations of the same account. */
export function estimateDeviceUsage(accountKey: string, observations: Observation[], samples: Sample[], events: LocalEvent[], maxGap = 60) {
  const sampleAt = new Map(samples.map((sample) => [sample.observedAt, sample]));
  const points = [...observations].sort((a, b) => a.observedAt - b.observedAt);
  const ordered = [...events].sort((a, b) => a.observedAt - b.observedAt);
  let cursor = 0, tokens = 0, estimatedPercent = 0, measuredIntervals = 0;
  let high: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1], next = points[i];
    while (cursor < ordered.length && ordered[cursor].observedAt <= previous.observedAt) cursor += 1;
    const begin = cursor;
    while (cursor < ordered.length && ordered[cursor].observedAt <= next.observedAt) cursor += 1;
    if (previous.accountKey !== accountKey || next.accountKey !== accountKey || next.observedAt - previous.observedAt > maxGap) { high = null; continue; }
    const left = sampleAt.get(previous.observedAt), right = sampleAt.get(next.observedAt);
    if (!left || !right || left.resetsAt !== right.resetsAt) { high = null; continue; }
    measuredIntervals += 1;
    const intervalTokens = ordered.slice(begin, cursor).reduce((sum, event) => sum + event.totalTokens, 0);
    tokens += intervalTokens;
    high = Math.max(high ?? left.usedPercent, left.usedPercent);
    if (right.usedPercent < high - 2.5) { high = right.usedPercent; continue; }
    if (intervalTokens > 0) estimatedPercent += Math.max(0, right.usedPercent - high);
    high = Math.max(high, right.usedPercent);
  }
  return { tokens, estimatedPercent, measuredIntervals };
}

export function createLocalAccountTracker(options: { dataDir: string; deviceId?: string; client?: AccountClient; pollMs?: number; now?: () => number }) {
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const secret = localSecret(options.dataDir);
  const db = new DatabaseSync(path.join(options.dataDir, 'local-account-usage.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS snapshots (
      account_key TEXT NOT NULL, duration INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      resets_at INTEGER NOT NULL, used_percent REAL NOT NULL,
      PRIMARY KEY (account_key, duration, observed_at, resets_at)
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, account_key TEXT
    );
    CREATE INDEX IF NOT EXISTS observations_time ON observations(observed_at);`);
  const insert = db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)');
  const observe = db.prepare('INSERT INTO observations (observed_at, account_key) VALUES (?, ?)');
  const client = options.client ?? new AppServerClient();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const pollMs = options.pollMs ?? 20_000;
  let current: { accountKey: string; observedAt: number; windows: RateLimitWindow[] } | null = null;
  let status = '等待账号信息';
  let generation = 0;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let estimateCache: { accountKey: string; at: number; windows: Record<number, ReturnType<typeof estimateDeviceUsage>> } | null = null;

  function accountHash(userId: string, accountId: string): string {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([userId, accountId])).digest('hex');
  }

  function invalidate(): void { generation += 1; current = null; status = '账号已变更，正在确认'; }
  async function refresh(): Promise<void> {
    if (running) return running;
    running = (async () => {
      current = null;
      status = '正在确认当前账号';
      // A different Codex process may change the active login without sending
      // this process a notification. Reload the auth state on each poll.
      client.stop();
      try {
        await client.start();
        let rate: unknown;
        let identity: { userId: string; accountId: string } | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const startedGeneration = generation;
          const before = await client.request('account/read', { refreshToken: false });
          rate = await client.request('account/rateLimits/read');
          const after = await client.request('account/read', { refreshToken: false });
          if (stopped) return;
          if (startedGeneration === generation) identity = verifiedIdentity(before, rate, after);
          if (identity) break;
        }
        if (!identity) { current = null; observe.run(now(), null); status = '无法确认当前账号，等待刷新'; return; }
        const accountKey = accountHash(identity.userId, identity.accountId);
        const observedAt = now();
        const windows = normalizeRateLimits(rate).map((window) => ({ ...window, observedAt }));
        db.exec('BEGIN IMMEDIATE');
        try {
          observe.run(observedAt, accountKey);
          for (const window of windows) insert.run(accountKey, Math.round(window.windowDurationMins), observedAt, window.resetsAt, window.usedPercent);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        current = { accountKey, observedAt, windows };
        estimateCache = null;
        status = windows.length ? '已连接' : '当前账号未返回额度窗口';
      } catch (error) {
        if (process.env.DEBUG_AI_USAGE_TRACKER === 'true') console.warn('Local account refresh failed:', (error as Error).message);
        if (!stopped) { current = null; observe.run(now(), null); status = '账号读取失败，正在重试'; }
      }
    })().finally(() => { running = null; });
    return running;
  }
  client.on('account/updated', () => { invalidate(); void refresh(); });
  client.on('disconnect', () => { invalidate(); status = '账号连接中断，正在重试'; });

  function localEvents(accountKey: string, since: number): LocalEvent[] {
    const source = path.join(options.dataDir, 'codex-usage.sqlite');
    if (!options.deviceId || !fs.existsSync(source)) return [];
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      const rows = sourceDb.prepare(`SELECT e.observed_at AS observedAt, e.total_tokens AS totalTokens, p.source_file AS sourceFile
        FROM session_part_token_events e JOIN session_parts p ON e.part_id = p.part_id
        WHERE e.device_id = ? AND p.device_id = ? AND e.observed_at >= ? ORDER BY e.observed_at`)
        .all(options.deviceId, options.deviceId, since) as unknown as Array<LocalEvent & { sourceFile: string }>;
      const owners = new Map<string, string | null>();
      for (const row of rows) {
        if (owners.has(row.sourceFile)) continue;
        let key: string | null = null;
        try {
          const fd = fs.openSync(row.sourceFile, 'r');
          const buffer = Buffer.alloc(262_144);
          let size: number;
          try { size = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
          const first = buffer.subarray(0, size).toString('utf8').split('\n', 1)[0];
          const data = JSON.parse(first) as { type?: string; payload?: { creator_user_id?: unknown; creator_account_id?: unknown } };
          const user = data.type === 'session_meta' ? data.payload?.creator_user_id : null;
          const account = data.type === 'session_meta' ? data.payload?.creator_account_id : null;
          if (typeof user === 'string' && user && typeof account === 'string' && account) key = accountHash(user, account);
        } catch { /* No reliable creator identity: leave this file unassigned. */ }
        owners.set(row.sourceFile, key);
      }
      return rows.filter((row) => owners.get(row.sourceFile) === accountKey)
        .map(({ observedAt, totalTokens }) => ({ observedAt, totalTokens }));
    } finally { sourceDb.close(); }
  }

  function estimates(accountKey: string, windows: RateLimitWindow[]) {
    if (estimateCache && estimateCache.accountKey === accountKey && now() - estimateCache.at < 20) return estimateCache.windows;
    const since = now() - 8 * 86_400;
    const observations = db.prepare('SELECT observed_at AS observedAt, account_key AS accountKey FROM observations WHERE observed_at >= ? ORDER BY observed_at, id')
      .all(since) as unknown as Observation[];
    const events = localEvents(accountKey, since);
    const result: Record<number, ReturnType<typeof estimateDeviceUsage>> = {};
    for (const window of windows) {
      const duration = Math.round(window.windowDurationMins);
      const windowStart = Math.max(since, window.resetsAt - duration * 60);
      const samples = db.prepare('SELECT observed_at AS observedAt, used_percent AS usedPercent, resets_at AS resetsAt FROM snapshots WHERE account_key = ? AND duration = ? AND resets_at = ? AND observed_at >= ? ORDER BY observed_at')
        .all(accountKey, duration, window.resetsAt, windowStart) as unknown as Sample[];
      result[duration] = estimateDeviceUsage(accountKey, observations.filter((o) => o.observedAt >= windowStart), samples, events.filter((e) => e.observedAt >= windowStart));
    }
    estimateCache = { accountKey, at: now(), windows: result };
    return result;
  }
  function view() {
    const fresh = current && now() - current.observedAt <= Math.ceil(pollMs / 1000) * 3 ? current : null;
    let device: Record<number, ReturnType<typeof estimateDeviceUsage>> = {};
    if (fresh) {
      try { device = estimates(fresh.accountKey, fresh.windows); }
      catch { /* Account quota remains available if local logs cannot be read. */ }
    }
    return {
      status: fresh ? status : current ? '账号信息已过期，等待刷新' : status,
      account: fresh ? { label: `账号 ${fresh.accountKey.slice(0, 8)}`, observedAt: fresh.observedAt } : null,
      windows: [300, 10_080].map((duration) => {
        const window = fresh?.windows.find((w) => Math.abs(w.windowDurationMins - duration) <= (duration === 300 ? 5 : 60));
        const estimate = window ? device[Math.round(window.windowDurationMins)] : null;
        return window ? { duration, available: true, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
          deviceEstimate: estimate && estimate.measuredIntervals > 0 && estimate.tokens > 0 ? estimate : null } : { duration, available: false, deviceEstimate: null };
      }),
      deviceUsage: { available: Boolean(fresh && Object.values(device).some((item) => item.measuredIntervals > 0 && item.tokens > 0)),
        reason: '按照会话创建账号和采样区间推测；同账号其他设备、账号快速切换或在同一会话切号可能导致偏差。' }
    };
  }
  return {
    refresh, view,
    start() { if (timer || stopped) return; void refresh(); timer = setInterval(() => void refresh(), pollMs); timer.unref(); },
    stop() { if (stopped) return; stopped = true; if (timer) clearInterval(timer); client.stop(); db.close(); }
  };
}
