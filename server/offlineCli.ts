import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { exportOffline, readOfflineFile } from './offline.js';
import { SYNC_PROTOCOL_VERSION } from './sync/protocol.js';

async function main() {
  const [action, flag, filePath] = process.argv.slice(2);
  if (!filePath || !((action === 'export' && flag === '--out') || (action === 'import' && flag === '--in'))) {
    throw new Error('Usage: npm run offline -- export --out <file.json> | npm run offline -- import --in <file.json>');
  }
  if (action === 'export') {
    const dataDir = path.resolve(process.env.DATA_DIR?.trim() || 'data');
    const identity = JSON.parse(fs.readFileSync(path.join(dataDir, 'device.json'), 'utf8')) as { deviceId: string };
    const file = exportOffline(dataDir, process.env.DEVICE_ID?.trim() || identity.deviceId);
    const json = JSON.stringify(file);
    if (Buffer.byteLength(json) > 100 * 1024 * 1024) throw new Error('Export exceeds the 100 MB import limit.');
    fs.writeFileSync(filePath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Exported ${file.records.length} usage records for ${file.deviceId} to ${filePath}.`);
  } else {
    const file = readOfflineFile(filePath);
    const secret = process.env.SYNC_SECRET?.trim();
    if (!secret) throw new Error('SYNC_SECRET is missing from this server configuration.');
    const port = Number(process.env.PORT || 8893);
    let count = 0;
    for (let i = 0; i < file.records.length; i += 500) {
      const records = file.records.slice(i, i + 500);
      const response = await fetch(`http://127.0.0.1:${port}/api/sync/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ protocol: SYNC_PROTOCOL_VERSION, privacy: 'usage-only-v1', offline: true, deviceId: file.deviceId, provider: 'codex', records })
      });
      const result = await response.json() as { error?: string; acked?: number[]; rejected?: unknown[] };
      if (!response.ok || result.rejected?.length || result.acked?.length !== records.length) throw new Error(result.error || `Import stopped after ${count} records. Retry the same file safely.`);
      count += records.length;
    }
    console.log(`Imported ${count} usage records from ${file.deviceId}; repeated imports are safe.`);
  }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
