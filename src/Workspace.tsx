import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, Pin, Plus } from 'lucide-react';
import { IconButton } from './ui';

export function Workspace({
  title,
  path,
  rows,
  selectedKey,
  query,
  onNew,
  creating = false,
  pinned,
  onPin,
}: {
  title: string;
  path?: string;
  rows: { key: string; content: ReactNode }[];
  selectedKey: string;
  query: string;
  onNew: () => void;
  creating?: boolean;
  pinned: boolean;
  onPin: () => void;
}) {
  const [limit, setLimit] = useState(5);
  const details = useRef<HTMLDetailsElement>(null);
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  useEffect(() => {
    setLimit(5);
  }, [query]);
  useEffect(() => {
    if (selectedIndex < 0) return;
    setLimit((current) =>
      Math.max(current, Math.ceil((selectedIndex + 1) / 5) * 5),
    );
    if (details.current) details.current.open = true;
  }, [selectedKey, selectedIndex]);
  useEffect(() => {
    if (selectedIndex < 0) return;
    if (selectedIndex < 5)
      details.current
        ?.querySelector('summary')
        ?.scrollIntoView({ block: 'nearest' });
    const row = details.current?.querySelector<HTMLElement>(
      '.session-row.selected',
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, limit]);
  return (
    <div className="workspace-group">
      <details className="workspace" ref={details} open>
        <summary title={path || title}>
          <FolderOpen size={18} />
          <span>{title}</span>
        </summary>
        {rows.slice(0, limit).map((row) => row.content)}
        {rows.length > limit && (
          <button
            className="workspace-more"
            aria-label={`Show more sessions in ${path || title}`}
            onClick={() => setLimit(limit + 5)}
          >
            …
          </button>
        )}
      </details>
      <IconButton
        className="icon-button workspace-pin"
        label={`${pinned ? 'Unpin' : 'Pin'} workspace ${path || title}`}
        aria-pressed={pinned}
        onClick={onPin}
      >
        <Pin size={15} fill={pinned ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton
        className="icon-button workspace-new"
        label={`New session in ${path || title}`}
        onClick={onNew}
        disabled={creating}
      >
        <Plus size={16} />
      </IconButton>
    </div>
  );
}
