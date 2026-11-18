import { useEffect, useState } from 'react';
import './private.css';

type Device = { deviceId: string; label: string; online: boolean; self: boolean };
type Window = { duration: number; available: boolean; usedPercent?: number; resetsAt?: number; provisional?: boolean; unattributedPercent?: number; devices: Array<{ deviceId: string; percent: number; tokens: number }> };
type Data = { updatedAt: number; devices: Device[]; windows: Window[] };
const pct = (value: number | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
const date = (value: number | undefined) => value ? new Date(value * 1000).toLocaleString() : '—';

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/device-summary?provider=codex', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as Data;
        if (alive) { setData(next); setError(''); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    };
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <main className="private-dashboard">
    <header><div className="eyebrow">CODEX USAGE</div><h1>设备用量</h1><p>仅显示设备额度与 Token，不显示会话内容。</p></header>
    {error && <p className="warning">读取失败：{error}</p>}
    {!data && !error && <p>正在读取用量…</p>}
    {data && <>
      <section className="private-grid">{data.windows.map((window) => <article className="private-card" key={window.duration}>
        <span className="caption">{window.duration === 300 ? '5 小时额度' : '每周额度'}</span>
        <div className="big">{window.available ? pct(window.usedPercent) : '未报告'}</div>
        <p>已使用 · 重置时间 {date(window.resetsAt)}</p>
        {window.provisional && <p className="note">数据仍在同步，设备占比可能变化。</p>}
      </article>)}</section>
      <section className="private-table"><h2>各设备用量</h2><p>额度占比根据采样和 Token 估算，可能随同步更新。</p>
        {data.windows.map((window) => <div key={window.duration} className="private-window"><h3>{window.duration === 300 ? '5 小时' : '本周'}</h3>
          {!window.available ? <p>账号未提供此额度窗口。</p> : <table><thead><tr><th>设备</th><th>状态</th><th>估算额度</th><th>Token</th></tr></thead>
            <tbody>{data.devices.map((device) => { const row = window.devices.find((item) => item.deviceId === device.deviceId); return <tr key={device.deviceId}>
              <td>{device.label}{device.self ? '（本机）' : ''}</td><td>{device.online ? '在线' : '离线'}</td><td>{row ? pct(row.percent) : '—'}</td><td>{row ? new Intl.NumberFormat().format(row.tokens) : '—'}</td>
            </tr>; })}</tbody></table>}
          {window.available && (window.unattributedPercent ?? 0) > 0.05 && <p>未归因：{pct(window.unattributedPercent)}</p>}
        </div>)}
      </section><footer>更新于 {date(data.updatedAt)} · 每 30 秒刷新</footer>
    </>}
  </main>;
}
