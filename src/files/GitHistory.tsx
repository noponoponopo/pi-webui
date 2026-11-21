import { useEffect, useState } from 'react';
import type { GitStatus } from '../../shared/git';
import { api } from '../lib/api';
import { ErrorNotice } from '../components/ui';

type History = { graph: string; remotes: string[]; upstream: string };

export function GitHistory({ status, disabled, onChange, onBusy }: { status: GitStatus & { isRepo: true }; disabled: boolean; onChange: () => void; onBusy: (busy: boolean) => void }) {
  const [history, setHistory] = useState<History>();
  const [remote, setRemote] = useState('');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [limit, setLimit] = useState(200);
  useEffect(() => {
    let active = true;
    setError('');
    api<History>(`/git/history?${new URLSearchParams({ cwd: status.root, limit: String(limit) })}`).then((data) => {
      if (!active) return;
      setHistory(data);
      setRemote((current) => data.remotes.includes(current) ? current : data.remotes.find((name) => data.upstream.startsWith(`${name}/`)) || data.remotes[0] || '');
    }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [status.root, status.indexVersion, refresh, limit]);
  useEffect(() => {
    let active = true;
    setDetail('');
    if (selected) api<{ detail: string }>(`/git/history?${new URLSearchParams({ cwd: status.root, commit: selected })}`).then((data) => { if (active) setDetail(data.detail); }).catch((reason) => { if (active) { setError(reason.message); setDetail('Could not load this commit.'); } });
    return () => { active = false; };
  }, [selected, status.root]);
  async function sync(action: 'fetch' | 'pull' | 'push') {
    if (!remote || busy || disabled) return;
    setBusy(action); onBusy(true); setError(''); setNotice('');
    try {
      await api('/git/sync', { cwd: status.root, action, remote, expectedIndexVersion: status.indexVersion });
      setNotice(`${action} completed`); setRefresh((n) => n + 1); onChange();
    } catch (reason) { setError((reason as Error).message); onChange(); }
    finally { setBusy(''); onBusy(false); }
  }
  return <div className="git-history">
    <div className="git-history-toolbar">
      <select aria-label="Remote" value={remote} onChange={(event) => setRemote(event.target.value)} disabled={!!busy || !history?.remotes.length}>
        {!history?.remotes.length && <option value="">No remote</option>}
        {history?.remotes.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      {(['fetch', 'pull', 'push'] as const).map((action) => <button key={action} disabled={!remote || !!busy || disabled} onClick={() => void sync(action)}>{busy === action ? `${action}…` : action}</button>)}
      {history?.upstream && <span>Tracking {history.upstream}</span>}
    </div>
    <ErrorNotice error={error} />
    {notice && <div role="status">{notice}</div>}
    <div className="git-history-content">
      <div className="git-history-list" aria-label="Commit graph">
        {history?.graph.split('\n').filter(Boolean).map((line, index) => {
          const match = line.match(/^([ |/*\\_-]*)([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.*)$/);
          return match ? <button key={`${match[2]}-${index}`} className={selected === match[2] ? 'selected' : ''} onClick={() => setSelected(match[2])}><span className="git-graph">{match[1]}</span><span>{match[3].split('\t').join('  ')}</span></button> : <div className="git-graph" key={index}>{line}</div>;
        })}
        {history && limit < 10000 && (history.graph.match(/[a-f0-9]{40}(?:[a-f0-9]{24})?\t/g)?.length ?? 0) >= limit && <button onClick={() => setLimit((value) => Math.min(value + 200, 10000))}>Load more</button>}
      </div>
      <pre className="git-history-detail">{selected ? detail || 'Loading…' : 'Select a commit.'}</pre>
    </div>
  </div>;
}
