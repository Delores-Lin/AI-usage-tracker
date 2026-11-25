import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { startDashboardListeners } from './dashboardListeners.js';

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('listener did not respond')), 5_000);
    timer.unref();
  })]);
}

test('loopback dashboard stays available when the configured private address is missing', async () => {
  const app = express();
  app.get('/test', (_req, res) => res.json({ ok: true }));
  let ready!: (port: number) => void;
  let failed!: (fatal: boolean) => void;
  const readyPromise = new Promise<number>((resolve) => { ready = resolve; });
  const errorPromise = new Promise<boolean>((resolve) => { failed = resolve; });
  const listeners = startDashboardListeners(app, {
    host: '192.0.2.123', port: 0, localFallback: true, retryMs: 100,
    onListening: (host, port) => { if (host === '127.0.0.1') ready(port); },
    onError: (_message, fatal) => failed(fatal)
  });
  try {
    const port = await within(readyPromise);
    assert.equal(await within(errorPromise), false);
    const response = await fetch(`http://127.0.0.1:${port}/test`);
    assert.deepEqual(await response.json(), { ok: true });
  } finally { listeners.close(); }
});

test('without loopback fallback an unavailable host remains a fatal error', async () => {
  const app = express();
  let failed!: (fatal: boolean) => void;
  const errorPromise = new Promise<boolean>((resolve) => { failed = resolve; });
  const listeners = startDashboardListeners(app, {
    host: '192.0.2.123', port: 0, localFallback: false,
    onListening: () => {}, onError: (_message, fatal) => failed(fatal)
  });
  try { assert.equal(await within(errorPromise), true); }
  finally { listeners.close(); }
});
