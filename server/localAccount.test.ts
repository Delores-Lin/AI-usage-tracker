import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createLocalAccountTracker, estimateDeviceUsage, verifiedIdentity } from './localAccount.js';

const account = (userId: string, id: string) => ({ userId, workspaceRouting: { chatgptAccountId: id } });
const rate = (accountId: string, used: number) => ({ accountId, rateLimits: { primary: { usedPercent: used, windowDurationMins: 10_080, resetsAt: 2_000_000_000 } } });

class FakeClient extends EventEmitter {
  values: unknown[] = [];
  async start() {}
  async request() { if (!this.values.length) throw new Error('not ready'); return this.values.shift(); }
  stop() {}
}

test('account identity must agree before and after the quota read', () => {
  assert.deepEqual(verifiedIdentity(account('user-a', 'workspace-a'), rate('workspace-a', 10), account('user-a', 'workspace-a')),
    { userId: 'user-a', accountId: 'workspace-a' });
  assert.equal(verifiedIdentity(account('user-a', 'workspace-a'), rate('workspace-b', 20), account('user-a', 'workspace-a')), null);
  assert.equal(verifiedIdentity(account('user-a', 'workspace-a'), rate('workspace-a', 20), account('user-b', 'workspace-b')), null);
  assert.equal(verifiedIdentity(account('user-a', 'workspace-a'), rate('workspace-a', 20), { userId: 'user-a' }), null);
});

test('estimates only within consecutive observations of the requested account', () => {
  const observations = [
    { observedAt: 100, accountKey: 'a' }, { observedAt: 110, accountKey: 'a' },
    { observedAt: 120, accountKey: 'b' }, { observedAt: 130, accountKey: 'a' },
    { observedAt: 140, accountKey: 'a' }, { observedAt: 300, accountKey: 'a' }
  ];
  const samples = [
    { observedAt: 100, usedPercent: 10, resetsAt: 500 }, { observedAt: 110, usedPercent: 12, resetsAt: 500 },
    { observedAt: 130, usedPercent: 12, resetsAt: 500 }, { observedAt: 140, usedPercent: 15, resetsAt: 500 },
    { observedAt: 300, usedPercent: 25, resetsAt: 500 }
  ];
  const result = estimateDeviceUsage('a', observations, samples, [
    { observedAt: 105, totalTokens: 100 }, { observedAt: 115, totalTokens: 900 },
    { observedAt: 125, totalTokens: 900 }, { observedAt: 135, totalTokens: 200 },
    { observedAt: 200, totalTokens: 900 }
  ]);
  assert.deepEqual(result, { tokens: 300, estimatedPercent: 5, measuredIntervals: 2 });
});

test('small quota fluctuations do not double-count the same increase', () => {
  const observations = [100, 110, 120, 130].map((observedAt) => ({ observedAt, accountKey: 'a' }));
  const samples = [10, 12, 11, 12].map((usedPercent, index) => ({ observedAt: 100 + index * 10, usedPercent, resetsAt: 500 }));
  const events = [105, 115, 125].map((observedAt) => ({ observedAt, totalTokens: 100 }));
  assert.equal(estimateDeviceUsage('a', observations, samples, events).estimatedPercent, 2);
});

test('retries a quota read if an account notification arrives during it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-notification-'));
  class NotifyingClient extends FakeClient {
    private sent = false;
    async request() {
      if (!this.sent) { this.sent = true; this.emit('account/updated'); }
      return super.request();
    }
  }
  const client = new NotifyingClient();
  const tracker = createLocalAccountTracker({ dataDir: dir, client, now: () => 1_800_000_000 });
  try {
    client.values.push(account('user-a', 'workspace-a'), rate('workspace-a', 12), account('user-a', 'workspace-a'),
      account('user-b', 'workspace-b'), rate('workspace-b', 35), account('user-b', 'workspace-b'));
    await tracker.refresh();
    assert.equal(tracker.view().windows[1].usedPercent, 35);
  } finally { tracker.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('switching accounts separates snapshots and refuses ambiguous data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-isolation-'));
  const client = new FakeClient();
  let clock = 1_800_000_000;
  const tracker = createLocalAccountTracker({ dataDir: dir, client, now: () => clock });
  try {
    client.values.push(account('user-a', 'workspace-a'), rate('workspace-a', 12), account('user-a', 'workspace-a'));
    await tracker.refresh();
    const a = tracker.view();
    assert.equal(a.windows[1].usedPercent, 12);
    assert.ok(a.account?.label);
    assert.equal(a.deviceUsage.available, false);
    clock += 20;
    client.values.push(account('user-b', 'workspace-b'), rate('workspace-b', 35), account('user-b', 'workspace-b'));
    await tracker.refresh();
    const b = tracker.view();
    assert.equal(b.windows[1].usedPercent, 35);
    assert.notEqual(b.account?.label, a.account?.label);
    clock += 20;
    client.values.push(account('user-b', 'workspace-b'), rate('workspace-b', 40), account('user-a', 'workspace-a'));
    await tracker.refresh();
    assert.equal(tracker.view().account, null);
    assert.equal(tracker.view().windows[1].available, false);
    const db = new DatabaseSync(path.join(dir, 'local-account-usage.sqlite'), { readOnly: true });
    const rows = db.prepare('SELECT account_key, used_percent FROM snapshots ORDER BY observed_at').all() as Array<{ account_key: string; used_percent: number }>;
    db.close();
    assert.deepEqual(rows.map((r) => r.used_percent), [12, 35]);
    assert.notEqual(rows[0].account_key, rows[1].account_key);
    assert.ok(rows.every((r) => !r.account_key.includes('user-') && !r.account_key.includes('workspace-')));
  } finally { tracker.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the local estimate ignores events created by another account and other devices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-account-events-'));
  const client = new FakeClient();
  let clock = 1_800_000_000;
  const source = new DatabaseSync(path.join(dir, 'codex-usage.sqlite'));
  source.exec(`CREATE TABLE session_parts (part_id TEXT, device_id TEXT, source_file TEXT);
    CREATE TABLE session_part_token_events (part_id TEXT, device_id TEXT, observed_at INTEGER, total_tokens INTEGER);`);
  const local = (name: string, user: string, accountId: string) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { creator_user_id: user, creator_account_id: accountId } }) + '\n');
    return file;
  };
  const part = source.prepare('INSERT INTO session_parts VALUES (?, ?, ?)');
  const event = source.prepare('INSERT INTO session_part_token_events VALUES (?, ?, ?, ?)');
  part.run('a', 'this-device', local('a', 'user-a', 'workspace-a'));
  part.run('b', 'this-device', local('b', 'user-b', 'workspace-b'));
  part.run('other', 'other-device', local('other', 'user-a', 'workspace-a'));
  event.run('a', 'this-device', clock + 5, 100);
  event.run('b', 'this-device', clock + 5, 1000);
  event.run('other', 'other-device', clock + 5, 1000);
  source.close();
  const tracker = createLocalAccountTracker({ dataDir: dir, deviceId: 'this-device', client, now: () => clock });
  const currentRate = (usedPercent: number) => ({ accountId: 'workspace-a', rateLimits: { primary: { usedPercent, windowDurationMins: 10_080, resetsAt: 1_800_600_000 } } });
  try {
    client.values.push(account('user-a', 'workspace-a'), currentRate(12), account('user-a', 'workspace-a'));
    await tracker.refresh();
    clock += 10;
    client.values.push(account('user-a', 'workspace-a'), currentRate(15), account('user-a', 'workspace-a'));
    await tracker.refresh();
    assert.deepEqual(tracker.view().windows[1].deviceEstimate, { tokens: 100, estimatedPercent: 3, measuredIntervals: 1 });
  } finally { tracker.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
