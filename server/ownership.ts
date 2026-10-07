import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type SessionOwner = {
  pid: number;
  token: string;
  kind: 'web' | 'cli';
  file: string;
};
export type SessionClaim = {
  file: string;
  assertOwner(): void;
  release(): void;
};

export function canonicalFile(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(realpathSync(dirname(resolve(file))), basename(file));
  }
}

function claimPath(file: string, root: string) {
  return join(
    root,
    createHash('sha256').update(canonicalFile(file)).digest('hex') + '.json',
  );
}

function readOwner(path: string): SessionOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token ||
      !['web', 'cli'].includes(value.kind) ||
      typeof value.file !== 'string'
    )
      throw new Error(
        'Invalid session ownership claim; inspect the lease before removing it',
      );
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

export function sessionOwner(
  file: string,
  root: string,
): SessionOwner | undefined {
  const owner = readOwner(claimPath(file, root));
  return owner && alive(owner.pid) ? owner : undefined;
}

function createClaim(path: string, owner: SessionOwner) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
}

export function claimSessionFile(
  file: string,
  root: string,
  kind: 'web' | 'cli',
): SessionClaim {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  file = canonicalFile(file);
  const path = claimPath(file, root);
  const owner: SessionOwner = {
    pid: process.pid,
    token: randomUUID(),
    kind,
    file,
  };
  try {
    createClaim(path, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Serialize stale-lease recovery so a concurrent reaper cannot remove a new owner.
    const recovery = path + '.recover';
    try {
      createClaim(recovery, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'Session ownership recovery is busy; inspect the recovery lease if its process exited',
        );
      throw error;
    }
    try {
      const previous = readOwner(path);
      if (previous && alive(previous.pid))
        throw new Error(
          `Session is owned by ${previous.kind === 'cli' ? 'CLI' : 'Web'} (PID ${previous.pid}). Close that session before resuming it here.`,
        );
      if (previous) unlinkSync(path);
      createClaim(path, owner);
    } finally {
      unlinkSync(recovery);
    }
  }
  let released = false;
  return {
    file,
    assertOwner() {
      if (released || readOwner(path)?.token !== owner.token)
        throw new Error(
          'Session ownership was lost; reconnect before sending input',
        );
    },
    release() {
      if (released) return;
      released = true;
      if (readOwner(path)?.token === owner.token) unlinkSync(path);
    },
  };
}
