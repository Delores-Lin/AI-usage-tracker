import assert from 'node:assert/strict';
import test from 'node:test';
import { exportOffline, isOfflineRecord, validateOfflineFile } from './offline.js';
import { parseSyncRecord } from './sync/protocol.js';
import { usageOnlyRecord } from './sync/privacy.js';
import { originalDeviceEstimate } from './originalEstimate.js';
import { addLocalChat, baseTime, localEvent, openStore, removeDir, sample, tempDir } from './testSupport.js';

test('offline export contains only device usage and late imports reattribute idempotently', () => {
  const sourceDir = tempDir('offline-source'), targetDir = tempDir('offline-target');
  const source = openStore(sourceDir, 'windows', { file: 'codex-usage.sqlite' });
  const target = openStore(targetDir, 'mac');
  try {
    const t = baseTime(), reset = t + 4 * 3600;
    const windows = [sample(t, 30, reset), sample(t + 60, 35, reset)];
    source.insertRateLimitSnapshots(windows);
    addLocalChat(source, 'SECRET-CONVERSATION-TITLE', [localEvent('secret-event', 'SECRET-CONVERSATION-TITLE', t + 30, 0.3)]);
    addLocalChat(target, 'mac-session', [localEvent('mac-event', 'mac-session', t + 20, 0.2)]);
    target.insertRateLimitSnapshots(windows);
    assert.equal(originalDeviceEstimate(target, windows[1], 'mac', null)?.estimatedPercent, 5);
    const file = exportOffline(sourceDir, 'windows');
    const json = JSON.stringify(file);
    assert.equal(json.includes('SECRET-CONVERSATION-TITLE'), false);
    assert.equal(json.includes('/logs/'), false);
    assert.equal(json.includes('secret-event'), false);
    assert.equal(file.records.filter((r) => r.kind === 'event').length, 1);
    assert.equal(validateOfflineFile(JSON.parse(json)).deviceId, 'windows');
    const event = file.records.find((r) => r.kind === 'event')!;
    const sameAsOnline = usageOnlyRecord({ seq: event.seq, kind: 'event', key: 'secret-event', data: { partId: 'SECRET-CONVERSATION-TITLE.jsonl', threadId: 'SECRET-CONVERSATION-TITLE' } });
    assert.equal(event.key, sameAsOnline?.key);
    const parsed = file.records.map((record) => parseSyncRecord(record)).map((record) => { if (typeof record === 'string') throw new Error(record); return record; });
    target.ingestRemoteRecords(file.deviceId, parsed);
    const first = originalDeviceEstimate(target, windows[1], 'mac', null)!;
    assert.ok(Math.abs(first.estimatedPercent - 2) < 1e-9);
    assert.ok(Math.abs(first.devices.find((d) => d.deviceId === 'windows')!.percent - 3) < 1e-9);
    target.ingestRemoteRecords(file.deviceId, parsed);
    assert.deepEqual(originalDeviceEstimate(target, windows[1], 'mac', null), first);
    assert.equal(isOfflineRecord({ ...event, data: { ...(event.data as object), prompt: 'SECRET' } }), false);
    assert.throws(() => validateOfflineFile({ ...file, records: [{ seq: 1, kind: 'prompt', key: 'x', data: { prompt: 'SECRET' } }] }));
  } finally { source.close(); target.close(); removeDir(sourceDir); removeDir(targetDir); }
});
