import { Bookmark, BookmarkMinus, Copy, Download, Pencil, Trash2 } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';

export function SessionMenu({
  x,
  y,
  available,
  bookmarked,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  available: boolean;
  bookmarked: boolean;
  onAction: (action: 'bookmark' | 'copy' | 'rename' | 'delete' | 'export-md' | 'export-jsonl') => void;
  onClose: () => void;
}) {
  const BookmarkIcon = bookmarked ? BookmarkMinus : Bookmark;

  return (
    <ContextMenu x={x} y={y} label="Session actions" onClose={onClose}>
      <button role="menuitem" onClick={() => onAction('bookmark')}>
        <BookmarkIcon size={15} />
        {bookmarked ? 'Remove bookmark' : 'Bookmark'}
      </button>
      <button
        role="menuitem"
        disabled={!available}
        onClick={() => onAction('copy')}
      >
        <Copy size={15} />
        Copy
      </button>
      <button
        role="menuitem"
        disabled={!available}
        onClick={() => onAction('rename')}
      >
        <Pencil size={15} />
        Rename
      </button>
      <button
        role="menuitem"
        disabled={!available}
        onClick={() => onAction('export-md')}
      >
        <Download size={15} />
        Download Markdown
      </button>
      <button
        role="menuitem"
        disabled={!available}
        onClick={() => onAction('export-jsonl')}
      >
        <Download size={15} />
        Download JSONL
      </button>
      <button
        role="menuitem"
        disabled={!available}
        onClick={() => onAction('delete')}
      >
        <Trash2 size={15} />
        Delete
      </button>
    </ContextMenu>
  );
}
