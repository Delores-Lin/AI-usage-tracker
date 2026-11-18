import { createHash } from 'node:crypto';
import type { SyncRecord } from './protocol.js';

// Apply before serializing: never upload conversation text, paths or titles.
const opaque = (value: unknown): string => createHash('sha256').update(String(value)).digest('hex');
const usageFields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
  'totalTokens', 'cacheWriteInputTokens', 'cacheWrite1hInputTokens', 'estimatedApiCostUsd'];
function pick(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
}
export function usageOnlyRecord(record: SyncRecord): SyncRecord | null {
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return null;
  const d = record.data as Record<string, unknown>;
  switch (record.kind) {
    case 'prompt': case 'thread': case 'remove-prompt': return null;
    case 'event': {
      const key = opaque(record.key);
      return { ...record, key, data: { ...pick(d, ['partKind', 'observedAt', 'model', ...usageFields]),
        eventId: key, partId: opaque(d.partId), threadId: opaque(d.threadId) } };
    }
    case 'part': {
      const key = opaque(record.key);
      return { ...record, key, data: { ...pick(d, ['partKind', 'startedAt', 'updatedAt', 'primaryModel', 'models',
        ...usageFields, 'pricingStatus', 'userMessageCount', 'reportedCostUsd']),
        partId: key, threadId: opaque(d.threadId), sourceFile: key,
        title: null, projectPath: null, source: 'unknown', sourceLabel: null } };
    }
    case 'sample':
      return { ...record, data: pick(d, ['key', 'label', 'usedPercent', 'windowDurationMins', 'resetsAt', 'observedAt']) };
    case 'remove-part': {
      const key = opaque(record.key);
      return { ...record, key, data: { partId: key } };
    }
    case 'remove-event': {
      const key = opaque(record.key);
      return { ...record, key, data: { eventId: key } };
    }
  }
}
