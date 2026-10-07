import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Session } from '../shared/types';

export function directory(path: string): string {
  const expanded =
    path === '~'
      ? homedir()
      : path.startsWith('~/')
        ? join(homedir(), path.slice(2))
        : path;
  const absolute = realpathSync(resolve(expanded));
  if (!statSync(absolute).isDirectory())
    throw new Error('Workspace must be a directory');
  return absolute;
}

export class Store {
  readonly sessionsDir: string;
  readonly sessions = new Map<string, Session>();
  private file: string;

  constructor(readonly root: string) {
    this.sessionsDir = join(root, 'sessions');
    this.file = join(root, 'sessions.json');
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    try {
      const saved: Session[] = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const session of saved) this.sessions.set(session.id, session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  save(session: Session) {
    this.sessions.set(session.id, session);
    this.persist();
  }

  remove(id: string) {
    this.sessions.delete(id);
    this.persist();
  }

  private persist() {
    writeFileSync(
      `${this.file}.tmp`,
      JSON.stringify([...this.sessions.values()]),
      { mode: 0o600 },
    );
    renameSync(`${this.file}.tmp`, this.file);
  }

  get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    return session;
  }
}
