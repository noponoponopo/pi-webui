import { useEffect, useMemo, useRef, useState } from 'react';
import { GitFork, RefreshCw, Search } from 'lucide-react';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { historyGraph, historyText, historyTree, type HistoryNode, type HistoryRow, type HistoryTree } from '../shared/session-tree';
import { CopyButton, ErrorNotice, IconButton, Modal } from './ui';
import './history.css';

const names: Record<HistoryNode['kind'], string> = {
  user: 'You', assistant: 'Pi', custom: 'Extension', compaction: 'Compaction', summary: 'Branch summary', checkpoint: 'Checkpoint',
};
const emptyEntry = (entry: HistoryNode) => entry.hasImages ? 'Image'
  : ['user', 'assistant', 'custom'].includes(entry.kind) ? 'Empty message' : 'Session checkpoint';
const historyTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const entryTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : historyTime.format(date);
};

function Graph({ row, columns, current }: { row: HistoryRow; columns: number; current: boolean }) {
  const x = (column: number) => 12 + column * 20;
  return (
    <svg className="history-graph" width={columns * 20 + 4} height="60" aria-hidden="true">
      {row.incoming.map((lane) => <path key={`in${lane}`} d={`M${x(lane)} 0V30`} />)}
      {row.outgoing.map((lane) => <path key={`out${lane}`} d={`M${x(lane)} 30V60`} />)}
      {row.join !== undefined && <path d={`M${x(row.column)} 30 C${x(row.column)} 46 ${x(row.join)} 44 ${x(row.join)} 60`} />}
      <circle className={current ? 'current' : row.active ? 'active' : ''} cx={x(row.column)} cy="30" r={current ? 5 : 4} />
    </svg>
  );
}

export function SessionHistory({ command, onClose, onBranch, disabled, error, native, liveLeafId }: {
  command: <T>(body: object) => Promise<T>;
  onClose: () => void;
  onBranch: (id: string, action: 'fork' | 'navigate_tree', position?: 'before' | 'at') => void;
  disabled?: string;
  error?: string;
  native: boolean;
  liveLeafId?: string | null;
}) {
  const [tree, setTree] = useState<HistoryTree>();
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = useState<{ id: string; text: string }>();
  const [detailError, setDetailError] = useState('');
  const fallback = useRef<SessionEntry[] | undefined>(undefined);
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const run = <T,>(operation: () => Promise<T>) => {
    const pending = queue.current.then(operation);
    queue.current = pending.then(() => {}, () => {});
    return pending;
  };
  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const value = await run(async () => {
        try {
          const result = await command<HistoryTree>({ type: 'get_history_tree' });
          fallback.current = undefined;
          return result;
        } catch (error) {
          if (!native || !(error as Error).message.includes('Unsupported native CLI command')) throw error;
          const result = await command<{ entries: SessionEntry[]; leafId: string | null }>({ type: 'get_entries' });
          fallback.current = result.entries;
          return historyTree(result.entries, result.leafId);
        }
      });
      setTree(value);
      setSelected((previous) => previous && value.entries.some((entry) => entry.id === previous)
        ? previous : value.leafId || value.entries.at(-1)?.id);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selected) return;
    const token = ++request.current;
    setDetail(undefined);
    setDetailError('');
    const entry = fallback.current?.find((item) => item.id === selected);
    const result = entry ? Promise.resolve({ text: historyText(entry) || tree?.entries.find((item) => item.id === selected)?.preview || '' })
      : run(() => token === request.current
        ? command<{ text: string }>({ type: 'get_history_entry', entryId: selected })
        : Promise.resolve({ text: '' }));
    void result.then((value) => {
      if (token === request.current) setDetail({ id: selected, text: value.text });
    }).catch((error) => {
      if (token === request.current) setDetailError((error as Error).message);
    });
    return () => { request.current++; };
  }, [selected, tree]);

  const { graph, matches, active } = useMemo(() => {
    const all = tree ?? { entries: [], leafId: null };
    const full = historyGraph(all);
    const active = new Set(full.rows.filter((row) => row.active).map((row) => row.entry.id));
    const term = query.trim().toLocaleLowerCase();
    if (!term) return { graph: full, matches: undefined, active };
    const byId = new Map(all.entries.map((entry) => [entry.id, entry]));
    const found = all.entries.filter((entry) => `${names[entry.kind]} ${entry.preview} ${entry.label || ''} ${entry.id}`.toLocaleLowerCase().includes(term));
    const included = new Set<string>();
    for (const entry of found) {
      for (let id: string | null = entry.id; id && !included.has(id); id = byId.get(id)?.parentId ?? null) included.add(id);
    }
    return { graph: historyGraph({ ...all, entries: all.entries.filter((entry) => included.has(entry.id)) }), matches: found.length, active };
  }, [tree, query]);
  useEffect(() => {
    if (!query && selected) list.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, tree, query]);
  const chosen = graph.rows.some((row) => row.entry.id === selected) ? tree?.entries.find((entry) => entry.id === selected) : undefined;
  const isCurrent = selected === tree?.leafId;
  const editable = chosen?.kind === 'user' || chosen?.kind === 'custom';
  const stale = tree && liveLeafId !== undefined && tree.leafId !== liveLeafId;
  const busyReason = disabled || (loading ? 'Loading history' : stale ? 'History changed; refresh before navigating'
    : chosen && !detailError && detail?.id !== chosen.id ? 'Loading entry' : undefined);
  return (
    <Modal title="Session history" className="history-dialog" onClose={onClose}>
      <div className="history-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input aria-label="Search history previews" placeholder="Search previews" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return;
              const first = list.current?.querySelector<HTMLButtonElement>('.history-node');
              if (first) { event.preventDefault(); first.focus(); first.click(); }
            }} />
        </label>
        <IconButton label="Refresh history" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></IconButton>
      </div>
      <div className="history-caption" role="status">
        {loading ? 'Loading history…' : stale ? 'History changed · refresh to update' : matches !== undefined ? `${matches} matches · showing their ancestors` : tree?.leafId ? 'Newest first · current branch highlighted' : 'Newest first · before the first entry'}
      </div>
      <ErrorNotice error={loadError || error} />
      <div className="history-layout">
        <div className="history-rows" aria-label="History tree" ref={list} onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.history-node'));
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          event.preventDefault();
          buttons[next]?.focus();
          buttons[next]?.click();
        }}>
          {graph.rows.map((row) => (
            <div className="history-row" key={row.entry.id}>
              <Graph row={{ ...row, active: active.has(row.entry.id) }} columns={graph.columns} current={row.entry.id === tree?.leafId} />
              <button className="history-node" aria-pressed={selected === row.entry.id} onClick={() => setSelected(row.entry.id)}>
                <span className="history-node-meta"><strong>{names[row.entry.kind]}</strong>{row.entry.id === tree?.leafId && <span className="history-current">Current</span>}{row.entry.label && <span className="history-label">{row.entry.label}</span>}<time dateTime={row.entry.timestamp}>{entryTime(row.entry.timestamp)}</time></span>
                <span className="history-node-preview">{row.entry.preview || emptyEntry(row.entry)}</span>
              </button>
            </div>
          ))}
          {!loading && !graph.rows.length && <p className="empty-note">{query ? 'No matching history' : 'No history yet'}</p>}
        </div>
        <section className="history-detail" aria-label="Selected history entry">
          {chosen ? <>
            <div className="history-detail-heading"><div><h3>{names[chosen.kind]}</h3><span>{new Date(chosen.timestamp).toLocaleString()} · {chosen.id}</span></div>{detail?.text && <CopyButton text={detail.text} />}</div>
            {chosen.label && <div className="history-detail-label">{chosen.label}</div>}
            <div className="history-detail-content">
              <ErrorNotice error={detailError} />
              {detail?.id === chosen.id ? <pre>{detail.text || emptyEntry(chosen)}</pre> : !detailError && <span className="muted">Loading…</span>}
            </div>
            <div className="history-detail-actions">
              <p>{isCurrent ? 'This is the current position' : editable ? 'Move before this message and restore its text to the composer' : 'Continue in this session after this entry'}</p>
              <p>Workspace files stay unchanged</p>
              {chosen.hasImages && <p>Images are not restored to the composer; attach them again</p>}
              {native && <p>Forking switches the connected CLI to the new session</p>}
              {busyReason && <p role="status">{busyReason}</p>}
              <div className="history-buttons">
                <button className="primary" disabled={Boolean(busyReason) || isCurrent} onClick={() => onBranch(chosen.id, 'navigate_tree')}>
                  {editable ? 'Edit and branch' : 'Continue here'}
                </button>
                <button disabled={Boolean(busyReason)} onClick={() => onBranch(chosen.id, 'fork', chosen.kind === 'user' ? 'before' : 'at')}>
                  <GitFork size={16} /> Fork to new session
                </button>
              </div>
            </div>
          </> : <p className="empty-note">Select an entry to inspect it</p>}
        </section>
      </div>
    </Modal>
  );
}
