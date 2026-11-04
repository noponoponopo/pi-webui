import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export type HistoryNode = {
  id: string;
  parentId: string | null;
  timestamp: string;
  kind: 'user' | 'assistant' | 'custom' | 'compaction' | 'summary' | 'checkpoint';
  preview: string;
  hasImages?: boolean;
  label?: string;
};
export type HistoryTree = { entries: HistoryNode[]; leafId: string | null };

export function historyText(entry: SessionEntry, limit = Infinity): string {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry.summary.slice(0, limit);
  const message = entry.type === 'message' ? entry.message : undefined;
  const content = entry.type === 'custom_message' ? entry.content
    : message && (message.role === 'user' || message.role === 'assistant') ? message.content : undefined;
  if (!content) return '';
  let text = '';
  if (typeof content === 'string') text = content.slice(0, limit);
  else for (const block of content) {
    if (block.type !== 'text') continue;
    if (text) text += '\n';
    text += block.text.slice(0, Math.max(0, limit - text.length));
    if (text.length >= limit) break;
  }
  return text || (message?.role === 'assistant' ? (message.errorMessage || '').slice(0, limit) : '');
}

export function checkpointText(entry: SessionEntry): string {
  switch (entry.type) {
    case 'model_change': return `Model: ${entry.provider}/${entry.modelId}`;
    case 'thinking_level_change': return `Thinking: ${entry.thinkingLevel}`;
    case 'label': return 'Label updated';
    case 'session_info': return 'Session renamed';
    case 'context_edit': return 'Context edited';
    case 'usage': return 'Usage recorded';
    case 'custom': return 'Extension state';
    case 'message': return entry.message.role === 'toolResult' ? `Tool result: ${entry.message.toolName}` : 'Session checkpoint';
    default: return 'Session checkpoint';
  }
}

export function historyTree(entries: SessionEntry[], leafId: string | null): HistoryTree {
  const children = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.parentId) children.set(entry.parentId, (children.get(entry.parentId) || 0) + 1);
    if (entry.type === 'label') {
      if (entry.label) labels.set(entry.targetId, entry.label);
      else labels.delete(entry.targetId);
    }
  }
  const nearest = new Map<string, string | null>();
  const result: HistoryNode[] = [];
  for (const entry of entries) {
    const parentId = entry.parentId ? nearest.get(entry.parentId) ?? null : null;
    const text = historyText(entry, 1000);
    const kind: HistoryNode['kind'] | undefined = entry.type === 'message' && entry.message.role === 'user'
      ? 'user'
      : entry.type === 'message' && entry.message.role === 'assistant' && text.trim()
        ? 'assistant'
        : entry.type === 'compaction' ? 'compaction'
          : entry.type === 'branch_summary' ? 'summary'
            : entry.type === 'custom_message' && (entry.display || (children.get(entry.id) || 0) > 1 || entry.id === leafId || labels.has(entry.id)) ? 'custom'
              : (children.get(entry.id) || 0) > 1 || entry.id === leafId || labels.has(entry.id)
                ? 'checkpoint' : undefined;
    if (kind) {
      const content = entry.type === 'custom_message' ? entry.content
        : entry.type === 'message' && entry.message.role === 'user' ? entry.message.content : undefined;
      const hasImages = Array.isArray(content) && content.some((block) => block.type === 'image');
      result.push({ id: entry.id, parentId, timestamp: entry.timestamp, kind,
        preview: (text || (kind === 'checkpoint' ? checkpointText(entry) : '')).slice(0, 1000).trim().replace(/\s+/g, ' ').slice(0, 240),
        ...(hasImages ? { hasImages: true } : {}), label: labels.get(entry.id) });
    }
    nearest.set(entry.id, kind ? entry.id : parentId);
  }
  return { entries: result, leafId };
}

export type HistoryRow = {
  entry: HistoryNode;
  column: number;
  incoming: number[];
  outgoing: number[];
  join?: number;
  active: boolean;
};

export function historyGraph(tree: HistoryTree): { rows: HistoryRow[]; columns: number } {
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  const active = new Set<string>();
  for (let id = tree.leafId; id && !active.has(id); id = byId.get(id)?.parentId ?? null) active.add(id);
  // Each lane waits for the parent of a row already visited in reverse order.
  const lanes: (string | null)[] = [];
  let columns = 1;
  const rows = [...tree.entries].reverse().map((entry): HistoryRow => {
    const incoming = lanes.flatMap((id, index) => id ? [index] : []);
    let column = lanes.indexOf(entry.id);
    if (column < 0) {
      column = lanes.indexOf(null);
      if (column < 0) column = lanes.length;
      lanes[column] = entry.id;
    }
    let join: number | undefined;
    if (entry.parentId && byId.has(entry.parentId)) {
      const parentColumn = lanes.indexOf(entry.parentId);
      if (parentColumn >= 0 && parentColumn !== column) {
        lanes[column] = null;
        join = parentColumn;
      } else lanes[column] = entry.parentId;
    } else lanes[column] = null;
    const outgoing = lanes.flatMap((id, index) => id ? [index] : []);
    columns = Math.max(columns, lanes.length);
    return { entry, column, incoming, outgoing, join, active: active.has(entry.id) };
  });
  return { rows, columns };
}
