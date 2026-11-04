import type { PiEvent, Projection, TranscriptItem, TranscriptPage } from './types';
import { applyEvent } from './transcript';

export const DISPLAY_PAGE_SIZE = 120;

export function transcriptPage(items: TranscriptItem[], before?: string): TranscriptPage {
  const end = before === undefined ? items.length : items.findIndex((item) => item.id === before);
  if (end < 0) throw new Error('History changed. Return to the latest messages.');
  const start = Math.max(0, end - DISPLAY_PAGE_SIZE);
  return { items: items.slice(start, end), before: start > 0 ? items[start].id : undefined, total: items.length };
}

/** Preserve loaded ancestors, but replace the tail with the authoritative live window. */
export function reconcileHistory(history: TranscriptPage, latest: Projection): TranscriptPage {
  const start = latest.before && latest.items.length
    ? history.items.findIndex((item) => item.id === latest.items[0].id)
    : -1;
  return {
    items: start > 0
      ? [...history.items.slice(0, start).filter((item) => !item.id.startsWith('live-')), ...latest.items]
      : latest.items,
    before: start >= 0 ? history.before : latest.before,
    total: latest.total ?? latest.items.length,
  };
}

/** Display-only reduction. The agent retains the complete, authoritative messages. */
export function applyDisplayEvent(previous: Projection, event: PiEvent, limit = DISPLAY_PAGE_SIZE): Projection {
  let next = applyEvent(previous, event);
  if (next === previous) return next;
  if (event.type === 'message_end') next.total = (previous.total ?? previous.items.length) + 1;
  if (next.items.length > limit) {
    const items = next.items.slice(-limit);
    next = { ...next, items, before: items[0].id };
  }
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    next.tools = { ...next.tools };
    delete next.tools[event.message.toolCallId];
  }
  if (event.type === 'agent_settled') next.tools = {};
  return next;
}
