import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ListenOptions {
  port: number;
  host?: string;
  localFallback: boolean;
  retryMs?: number;
  onListening: (host: string, port: number) => void;
  onError: (message: string, fatal: boolean) => void;
}

/** Keep the dashboard reachable on loopback when a configured private interface disappears. */
export function startDashboardListeners(app: Express, options: ListenOptions) {
  const host = options.host;
  const separateLocal = options.localFallback && !!host && host !== '127.0.0.1' && host !== 'localhost';
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let privateUnavailable = false;
  const servers = new Set<Server>();

  function listen(address: string | undefined, port: number, local: boolean) {
    if (stopped) return;
    const server = address ? app.listen(port, address) : app.listen(port);
    servers.add(server);
    server.once('error', (error: NodeJS.ErrnoException) => {
      servers.delete(server);
      if (stopped) return;
      const fatal = local || !separateLocal;
      if (fatal || !privateUnavailable) options.onError(`Cannot listen on ${address ?? 'all interfaces'}:${port}: ${error.message}`, fatal);
      if (!fatal) {
        privateUnavailable = true;
        retry = setTimeout(() => { retry = null; listen(address, port, false); }, options.retryMs ?? 15_000);
        retry.unref();
      }
    });
    server.once('listening', () => {
      const boundPort = (server.address() as AddressInfo).port;
      if (!local) privateUnavailable = false;
      options.onListening(address ?? 'localhost', boundPort);
      // Starting the private listener after loopback ensures local access is
      // already available, including if the private interface is absent.
      if (local) listen(host, boundPort, false);
    });
  }

  if (separateLocal) listen('127.0.0.1', options.port, true);
  else listen(host, options.port, false);
  return {
    close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      for (const server of servers) if (server.listening) server.close();
      servers.clear();
    }
  };
}
