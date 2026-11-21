import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, Pin, Plus } from 'lucide-react';
import { IconButton } from '../components/ui';

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
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  dragOver = false,
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
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDragStart?: () => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (event: React.DragEvent) => void;
  dragOver?: boolean;
}) {
  const [limit, setLimit] = useState(5);
  const details = useRef<HTMLDetailsElement>(null);
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  const forcedOpen = pinned || Boolean(query) || selectedIndex >= 0;
  const isOpen = forcedOpen || (controlledOpen ?? defaultOpen);
  useEffect(() => {
    setLimit(5);
  }, [query]);
  useEffect(() => {
    if (selectedIndex < 0) return;
    setLimit((current) =>
      Math.max(current, Math.ceil((selectedIndex + 1) / 5) * 5),
    );
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
    <div
      className={`workspace-group ${dragOver ? 'drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <details
        className="workspace"
        ref={details}
        open={isOpen}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (!forcedOpen && next !== isOpen) onOpenChange?.(next);
        }}
      >
        <summary
          title={path || title}
          draggable={Boolean(onDragStart)}
          onDragStart={onDragStart}
        >
          <FolderOpen size={17} />
          <span>{title}</span>
        </summary>
        {rows.slice(0, limit).map((row) => row.content)}
        {rows.length > limit && (
          <button
            className="workspace-more"
            aria-label={`Show more sessions in ${path || title}`}
            onClick={() => setLimit(limit + 5)}
          >
            Show more ({rows.length - limit})
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
