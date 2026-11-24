import type { UsageStore } from './db.js';
import type { RateLimitWindow } from './types.js';
import { windowDetail } from './windows.js';

/** The upstream per-window attribution, reduced to device totals only. */
export function originalDeviceEstimate(store: UsageStore, window: RateLimitWindow, deviceId: string, settledThrough: number | null) {
  const detail = windowDetail(store, window.windowDurationMins, undefined, window.resetsAt, window, { settledThrough });
  if (!detail || detail.samples < 2) return null;
  const device = detail.devices.find((row) => row.deviceId === deviceId);
  if (!device) return null;
  return {
    estimatedPercent: device.percent,
    tokens: device.tokens,
    observedDeltaPercent: detail.observedDeltaPercent,
    unattributedPercent: detail.unattributedPercent,
    samples: detail.samples,
    provisional: detail.provisional
  };
}
