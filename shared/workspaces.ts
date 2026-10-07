import type { HistoryRow, SessionRow } from './types';

export type WorkspaceSession = {
  key: string;
  cwd: string;
  name: string;
  updatedAt: number;
  session?: SessionRow;
  history?: HistoryRow;
};

export function workspaceSessions(
  sessions: SessionRow[],
  history: HistoryRow[],
): WorkspaceSession[] {
  const represented = new Set(
    sessions.flatMap((session) => (session.file ? [session.file] : [])),
  );
  return [
    ...sessions.filter((session) => session.hasMessages !== false).map((session) => ({
      key: session.id,
      cwd: session.cwd,
      name: session.source
        ? `${session.name.split('\n')[0]} · Copy`
        : session.name.split('\n')[0],
      updatedAt: session.updatedAt,
      session,
    })),
    ...history
      .filter((row) => row.hasMessages !== false && !represented.has(row.path))
      .map((row) => ({
        key: row.path,
        cwd: row.cwd,
        name: row.name,
        updatedAt: row.updatedAt,
        history: row,
      })),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function workspaceOrder(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  const known = new Set(previous);
  return [...current.filter((cwd) => !known.has(cwd)), ...previous];
}
