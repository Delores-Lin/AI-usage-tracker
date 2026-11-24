import assert from 'node:assert/strict';
import test from 'node:test';
import { originalDeviceEstimate } from './originalEstimate.js';
import { addLocalChat, baseTime, eventRecords, localEvent, openStore, remoteEvent, removeDir, sample, tempDir } from './testSupport.js';

test('the privacy dashboard uses original cost-weighted device attribution without chat details', () => {
  const directory = tempDir('original-device-estimate');
  const store = openStore(directory, 'server');
  try {
    const t = baseTime(), resets = t + 4 * 3600;
    store.insertRateLimitSnapshots([sample(t, 30, resets), sample(t + 60, 35, resets)]);
    addLocalChat(store, 'private-thread-name', [localEvent('local-event', 'private-thread-name', t + 20, 0.2)]);
    store.ingestRemoteRecords('laptop', eventRecords([remoteEvent('remote-event', 'other-private-thread', t + 30, 0.3)]));
    const result = originalDeviceEstimate(store, sample(t + 60, 35, resets), 'server', null);
    assert.ok(result);
    assert.ok(Math.abs(result.estimatedPercent - 2) < 1e-9);
    assert.equal(result.tokens, 1000);
    assert.equal(result.observedDeltaPercent, 5);
    assert.equal(result.unattributedPercent, 0);
    assert.equal(JSON.stringify(result).includes('private-thread'), false);
    assert.equal(originalDeviceEstimate(store, sample(t + 60, 35, resets), 'absent-device', null), null);
  } finally { store.close(); removeDir(directory); }
});
