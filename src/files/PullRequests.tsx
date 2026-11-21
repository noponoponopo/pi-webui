import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '../../shared/git';
import { api } from '../lib/api';
import { ErrorNotice } from '../components/ui';

type Item = { number: number; title: string; state: string; url: string; body: string; head: string; base: string };
type Row = Record<string, unknown>;
function normalize(raw: unknown): Item {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Row;
  const get = (...names: string[]) => {
    for (const name of names) if (row[name] != null) return row[name];
    return '';
  };
  const branch = (value: unknown) => typeof value === 'string' ? value : String((value as Row | null)?.ref ?? '');
  return {
    number: Number(get('number', 'index', 'iid', 'Number', 'Index')),
    title: String(get('title', 'Title')),
    state: get('hasMerged', 'merged_at', 'mergedAt') ? 'merged' : String(get('state', 'State')),
    url: String(get('url', 'html_url', 'web_url', 'URL')),
    body: String(get('body', 'description', 'Body')),
    head: branch(get('headRefName', 'source_branch', 'head', 'Head')),
    base: branch(get('baseRefName', 'target_branch', 'base', 'Base')),
  };
}

export function PullRequests({ status, onBusy }: { status: GitStatus & { isRepo: true }; onBusy: (busy: boolean) => void }) {
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remote, setRemote] = useState('');
  const [provider, setProvider] = useState('github');
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item>();
  const [diff, setDiff] = useState<string>();
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [head, setHead] = useState(status.branch ?? '');
  const [base, setBase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    api<{ remotes: string[] }>(`/git/history?${new URLSearchParams({ cwd: status.root })}`).then((data) => {
      if (active) { setRemotes(data.remotes); setRemote(data.remotes[0] ?? ''); }
    }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [status.root]);
  async function request(action: string, extra: object = {}) {
    return api<{ data?: unknown; output?: string }>('/git/pull-requests', { cwd: status.root, remote, provider, action, ...extra });
  }
  async function list() {
    if (!remote || busyRef.current) return;
    const current = ++generation.current;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await request('list');
      if (current !== generation.current) return;
      if (!Array.isArray(result.data)) throw new Error('Unexpected pull request list');
      setItems(result.data.map(normalize).filter((item) => Number.isSafeInteger(item.number) && item.number > 0));
    } catch (reason) { if (current === generation.current) setError((reason as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function view(number: number) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await request('view', { number });
      const data = Array.isArray(result.data) ? result.data[0] : result.data;
      const item = normalize(data);
      if (!item.number) throw new Error('Unexpected pull request details');
      setSelected(item); setDiff(undefined); setMode('view');
    } catch (reason) { setError((reason as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function showDiff() {
    if (!selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { const result = await request('diff', { number: selected.number }); setDiff(result.output ?? ''); }
    catch (reason) { setError((reason as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function mutate(action: 'create' | 'edit' | 'close' | 'reopen' | 'merge') {
    if (busyRef.current) return;
    if (['close', 'reopen', 'merge'].includes(action) && !window.confirm(`${action} #${selected?.number} on ${remote}?`)) return;
    busyRef.current = true; setBusy(true); onBusy(true); setError(''); setNotice('');
    try {
      const result = await request(action, action === 'create' ? { title, body, head, base } : action === 'edit' ? { number: selected?.number, title, body } : { number: selected?.number });
      setNotice(result.output || `${action} completed`); setMode('view'); setSelected(undefined);
    } catch (reason) { setError((reason as Error).message); return; }
    finally { busyRef.current = false; setBusy(false); onBusy(false); }
    await list();
  }
  useEffect(() => { setItems([]); setSelected(undefined); setMode('view'); setNotice(''); if (remote) void list(); }, [remote, provider]);
  const link = selected?.url && /^https?:\/\//i.test(selected.url) ? selected.url : undefined;
  return <section className="git-pr">
    <div className="git-history-toolbar">
      <select aria-label="Remote" value={remote} disabled={busy} onChange={(e) => setRemote(e.target.value)}>{remotes.map((name) => <option key={name}>{name}</option>)}</select>
      <select aria-label="Git hosting service" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value)}><option value="github">GitHub</option><option value="gitea">Gitea / Forgejo</option><option value="gitlab">GitLab</option></select>
      <button disabled={busy || !remote} onClick={() => void list()}>Refresh</button>
      <button disabled={busy || !remote} onClick={() => { setMode('create'); setTitle(''); setBody(''); setHead(status.branch ?? ''); setBase(''); }}>New PR / MR</button>
    </div>
    <ErrorNotice error={error} />{notice && <div role="status">{notice}</div>}
    <div className="git-pr-content">
      <div className="git-pr-list" aria-label="Pull requests">{items.map((item) => <button key={item.number} className={selected?.number === item.number ? 'selected' : ''} disabled={busy} onClick={() => void view(item.number)}><span>#{item.number} {item.title}</span><small>{item.state}</small></button>)}{!items.length && !busy && <p>No pull requests loaded.</p>}</div>
      <div className="git-pr-detail">
        {mode === 'view' ? selected ? <><h3>#{selected.number} {selected.title}</h3><p>{selected.state} · {selected.head} → {selected.base} {link && <a href={link} target="_blank" rel="noreferrer">Open in browser</a>}</p><pre>{selected.body}</pre><div className="git-history-toolbar"><button disabled={busy} onClick={() => diff === undefined ? void showDiff() : setDiff(undefined)}>{diff === undefined ? 'Show diff' : 'Hide diff'}</button><button disabled={busy} onClick={() => { setTitle(selected.title); setBody(selected.body); setMode('edit'); }}>Edit</button><button disabled={busy || selected.state.toLowerCase() === 'merged'} onClick={() => void mutate(selected.state.toLowerCase() === 'open' || selected.state.toLowerCase() === 'opened' ? 'close' : 'reopen')}>{['open', 'opened'].includes(selected.state.toLowerCase()) ? 'Close' : 'Reopen'}</button><button disabled={busy || !['open', 'opened'].includes(selected.state.toLowerCase())} onClick={() => void mutate('merge')}>Merge</button></div>{diff !== undefined && <pre className="git-pr-diff">{diff || 'No changes.'}</pre>}</> : <p>Select a pull request.</p> : <form onSubmit={(event) => { event.preventDefault(); void mutate(mode === 'create' ? 'create' : 'edit'); }}>
          <label>Title<input value={title} maxLength={500} required onChange={(e) => setTitle(e.target.value)} /></label>
          {mode === 'create' && <><label>Source branch<input value={head} required onChange={(e) => setHead(e.target.value)} /></label><label>Target branch<input value={base} required onChange={(e) => setBase(e.target.value)} /></label></>}
          <label>Description<textarea value={body} maxLength={50000} rows={8} onChange={(e) => setBody(e.target.value)} /></label>
          <div className="git-history-toolbar"><button type="button" disabled={busy} onClick={() => setMode('view')}>Cancel</button><button className="primary" disabled={busy || !title.trim()}>{mode === 'create' ? 'Create' : 'Save'}</button></div>
        </form>}
      </div>
    </div>
  </section>;
}
