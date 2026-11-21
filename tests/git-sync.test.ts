import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getGitStatus, gitHistory, syncGit } from '../server/git';

test('history and remote synchronization operate on the selected branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-webui-git-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  try {
    git(dir, 'init', '--bare', 'remote.git');
    git(dir, 'init', '-b', 'main', 'work');
    const cwd = join(dir, 'work');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'remote', 'add', 'origin', join(dir, 'remote.git'));
    await writeFile(join(cwd, 'file'), 'one\n');
    git(cwd, 'add', 'file');
    git(cwd, 'commit', '-m', 'first');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('repository missing');
    await syncGit(cwd, 'push', 'origin', status.indexVersion);
    const history = await gitHistory(cwd);
    expect(history.graph).toContain('first');
    expect(history.upstream).toBe('origin/main');
    expect((await gitHistory(cwd, git(cwd, 'rev-parse', 'HEAD'))).detail).toContain('+one');
    await syncGit(cwd, 'fetch', 'origin', status.indexVersion);
    await syncGit(cwd, 'pull', 'origin', status.indexVersion);
    await expect(syncGit(cwd, 'push', 'origin', '0'.repeat(64))).rejects.toThrow('Git index changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
