import type { UsageStore } from './db.js';
import type { RateLimitWindow } from './types.js';
import { windowDetail } from './windows.js';

/** The upstream per-window attribution, reduced to device totals only. */
export function originalDeviceEstimate(store: UsageStore, window: RateLimitWindow, deviceId: string, settledThrough: number | null) {
  const detail = windowDetail(store, window.windowDurationMins, undefined, window.resetsAt, window, { settledThrough });
  if (!detail || detail.samples < 2) return null;
  const device = detail.devices.find((row) => row.deviceId === deviceId);
  return {
    estimatedPercent: device?.percent ?? 0,
    tokens: device?.tokens ?? 0,
    devices: detail.devices.map(({ deviceId, percent, tokens }) => ({ deviceId, percent, tokens })),
    observedDeltaPercent: detail.observedDeltaPercent,
    unattributedPercent: detail.unattributedPercent,
    samples: detail.samples,
    provisional: detail.provisional
  };
}
