import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageOnlyRecord } from './sync/privacy.js';
import { parseSyncRecord, sampleRecordKey, type SyncRecord } from './sync/protocol.js';

const DEVICE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MODEL = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;
const EVENT_FIELDS = new Set(['eventId', 'partId', 'threadId', 'partKind', 'observedAt', 'model', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'estimatedApiCostUsd']);
const SAMPLE_FIELDS = new Set(['key', 'label', 'usedPercent', 'windowDurationMins', 'resetsAt', 'observedAt']);
export interface OfflineFile { format: 'ai-usage-tracker-offline'; version: 1; deviceId: string; exportedAt: number; records: SyncRecord[] }

/** Strictly allow only the aggregate inputs. Never accept prompts or arbitrary fields. */
export function isOfflineRecord(value: unknown): value is SyncRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as SyncRecord;
  if (Object.keys(record).some((key) => !['seq', 'kind', 'key', 'data'].includes(key))) return false;
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return false;
  const data = record.data as Record<string, unknown>;
  if (record.kind === 'event') {
    if (Object.keys(data).some((key) => !EVENT_FIELDS.has(key))) return false;
    if (!HASH.test(record.key) || data.eventId !== record.key || typeof data.partId !== 'string' || !HASH.test(data.partId) || typeof data.threadId !== 'string' || !HASH.test(data.threadId) || typeof data.model !== 'string' || !MODEL.test(data.model)) return false;
  } else if (record.kind === 'sample') {
    if (Object.keys(data).some((key) => !SAMPLE_FIELDS.has(key))) return false;
    if (!((['five-hour', 'codex:primary'].includes(String(data.key)) && data.windowDurationMins === 300 && data.label === '5-hour window') || (['seven-day', 'codex:secondary'].includes(String(data.key)) && data.windowDurationMins === 10080 && data.label === '7-day window'))) return false;
    if (record.key !== sampleRecordKey(data as unknown as { observedAt: number; key: string; resetsAt: number })) return false;
  } else return false;
  return typeof parseSyncRecord(record) !== 'string';
}

export function validateOfflineFile(value: unknown): OfflineFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid offline file.');
  const file = value as OfflineFile;
  if (Object.keys(file).some((key) => !['format', 'version', 'deviceId', 'exportedAt', 'records'].includes(key)) || file.format !== 'ai-usage-tracker-offline' || file.version !== 1 || typeof file.deviceId !== 'string' || !DEVICE.test(file.deviceId) || !Number.isSafeInteger(file.exportedAt) || !Array.isArray(file.records) || !file.records.every(isOfflineRecord)) throw new Error('Invalid or unsafe offline file; nothing was imported.');
  return file;
}

/** Read only usage columns belonging to this device; no conversation tables are read. */
export function exportOffline(dataDir: string, deviceId: string): OfflineFile {
  if (!DEVICE.test(deviceId)) throw new Error('Invalid device ID.');
  const db = new DatabaseSync(path.join(dataDir, 'codex-usage.sqlite'), { readOnly: true });
  try {
    const records: SyncRecord[] = [];
    const events = db.prepare(`SELECT event_key AS eventId, part_id AS partId, thread_id AS threadId,
      part_kind AS partKind, observed_at AS observedAt, model, input_tokens AS inputTokens,
      cached_input_tokens AS cachedInputTokens, cache_write_input_tokens AS cacheWriteInputTokens,
      cache_write_1h_input_tokens AS cacheWrite1hInputTokens, output_tokens AS outputTokens,
      reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
      estimated_cost_usd AS estimatedApiCostUsd FROM session_part_token_events WHERE device_id = ? ORDER BY observed_at`).all(deviceId);
    for (const event of events) {
      const record = usageOnlyRecord({ seq: records.length + 1, kind: 'event', key: String(event.eventId), data: event });
      if (!isOfflineRecord(record)) throw new Error('A usage event is invalid or has an unsafe model identifier; export stopped.');
      records.push(record);
    }
    // Snapshots are account-wide. Only use canonical windows and locally observed or legacy samples.
    const samples = db.prepare(`SELECT limit_key AS key, used_percent AS usedPercent, duration_mins AS windowDurationMins,
      resets_at AS resetsAt, observed_at AS observedAt FROM rate_limit_snapshots
      WHERE (device_id IS NULL OR device_id = ?) AND ((limit_key IN ('five-hour', 'codex:primary') AND duration_mins = 300) OR (limit_key IN ('seven-day', 'codex:secondary') AND duration_mins = 10080)) ORDER BY observed_at`).all(deviceId);
    for (const sample of samples) {
      const data = { ...sample, label: sample.windowDurationMins === 300 ? '5-hour window' : '7-day window' };
      const record: SyncRecord = { seq: records.length + 1, kind: 'sample', key: sampleRecordKey(data as unknown as { observedAt: number; key: string; resetsAt: number }), data };
      if (!isOfflineRecord(record)) throw new Error('A quota sample is invalid; export stopped.');
      records.push(record);
    }
    return { format: 'ai-usage-tracker-offline', version: 1, deviceId, exportedAt: Math.floor(Date.now() / 1000), records };
  } finally { db.close(); }
}

export function readOfflineFile(filePath: string): OfflineFile {
  const stat = fs.statSync(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error('Offline file exceeds the 100 MB limit.');
  return validateOfflineFile(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
