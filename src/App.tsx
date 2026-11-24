import { useEffect, useState } from 'react';
import './private.css';

type Window = { duration: number; available: boolean; usedPercent?: number; resetsAt?: number; deviceEstimate?: { tokens: number; estimatedPercent: number; observedDeltaPercent: number; unattributedPercent: number; samples: number; provisional: boolean } | null };
type Data = { status: string; account: { label: string; observedAt: number } | null; windows: Window[]; deviceUsage: { available: boolean; reason: string } };
const pct = (value: number | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
const points = (value: number) => `${value.toFixed(1)} 个百分点`;
const date = (value: number | undefined) => value ? new Date(value * 1000).toLocaleString() : '—';

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/local-account', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as Data;
        if (alive) { setData(next); setError(''); }
      } catch (e) { if (alive) { setData(null); setError(e instanceof Error ? e.message : String(e)); } }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <main className="private-dashboard">
    <header><div className="eyebrow">CODEX USAGE</div><h1>当前账号用量</h1><p>本机账号视图 · 不显示对话内容</p></header>
    {error && <p className="warning" role="alert">读取失败：{error}</p>}
    {!data && !error && <p aria-live="polite">正在读取账号…</p>}
    {data && <>
      <section className="private-account" aria-live="polite"><strong>{data.account?.label ?? '未确认账号'}</strong><span>{data.status}</span>
        <p>账号额度会重新确认；下方原版设备估算使用未按账号隔离的历史记录。</p></section>
      <section className="private-grid">{data.windows.map((window) => <article className="private-card" key={window.duration}>
        <span className="caption">{window.duration === 300 ? '5 小时账号额度' : '每周账号额度'}</span>
        <div className="big">{window.available ? pct(window.usedPercent) : '未报告'}</div>
        <p>账号整体已用 · 重置时间 {date(window.resetsAt)}</p>
      </article>)}</section>
      <section className="private-table"><h2>本机额度消耗（原版估算）</h2>
        <p>原版按照额度变化时各设备活动的模型参考费用进行分配。</p>
        <table><thead><tr><th>额度窗口</th><th>本机估算</th><th>未归因</th><th>相关 Token</th></tr></thead><tbody>
          {data.windows.map((window) => <tr key={window.duration}><td>{window.duration === 300 ? '5 小时' : '每周'}</td>
            <td>{window.deviceEstimate ? points(window.deviceEstimate.estimatedPercent) : '采样不足'}</td>
            <td>{window.deviceEstimate ? points(window.deviceEstimate.unattributedPercent) : '—'}</td>
            <td>{window.deviceEstimate ? new Intl.NumberFormat().format(window.deviceEstimate.tokens) : '—'}</td></tr>)}
        </tbody></table>
        <p className="note">{data.deviceUsage.reason} 这不是官方逐设备账单。</p>
        <p>原版可能将额度回落视为新的统计段；累计增幅和设备估算可能高于当前账号已用百分比。</p>
        <p>上方账号总用量包含该账号在所有设备上的使用。</p>
      </section><footer>最近确认 {date(data.account?.observedAt)} · 每 5 秒刷新显示</footer>
    </>}
  </main>;
}
