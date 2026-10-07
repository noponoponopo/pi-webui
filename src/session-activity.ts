import type { SessionRow } from '../shared/types';
import type { WorkspaceSession } from '../shared/workspaces';

export type SessionActivity = Record<string, { id: string; error: boolean; unread: boolean }>;
export const sessionKey = (row: WorkspaceSession) => row.session?.file || row.history?.path || row.key;

export function updateActivity(previous: SessionActivity, sessions: SessionRow[], readingId: string): SessionActivity {
  let next = previous;
  for (const session of sessions) {
    const key = session.file || session.id;
    const completion = session.completion;
    const existing = next[key];
    const activity = completion && completion.id !== existing?.id
      ? { id: completion.id, error: Boolean(completion.error), unread: true }
      : existing;
    if (!activity) continue;
    const unread = activity.unread && session.id !== readingId;
    if (existing !== activity || unread !== activity.unread) {
      if (next === previous) next = { ...previous };
      next[key] = { ...activity, unread };
    }
  }
  return next;
}

export function storedActivity(): SessionActivity {
  try {
    const saved = JSON.parse(localStorage.getItem('pi-webui-session-activity') || '{}');
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => {
      const item = value as SessionActivity[string] | null;
      return item && typeof item.id === 'string' && typeof item.error === 'boolean' && typeof item.unread === 'boolean';
    })) as SessionActivity;
  } catch {
    return {};
  }
}

export function storedBookmarks(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('pi-webui-session-bookmarks') || '[]');
    return Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}
