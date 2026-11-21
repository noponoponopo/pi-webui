import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pullRequests } from '../server/pull-requests';

test('pull request actions target the selected remote and validate input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-webui-pr-'));
  const path = process.env.PATH;
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    const log = join(dir, 'calls');
    for (const name of ['gh', 'tea', 'glab']) {
      const file = join(bin, name);
      await writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${log}'\ncase "$*" in 'login list'*) echo '[{"name":"git.example.com","url":"https://git.example.com"}]';; *'--json'*|*'--output json'*) echo '[]';; *) echo ok;; esac\n`);
      await chmod(file, 0o755);
    }
    process.env.PATH = `${bin}:${path}`;
    execFileSync('git', ['init', dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@git.example.com:owner/repo.git']);
    const input = { cwd: dir, remote: 'origin', provider: 'github' };
    await pullRequests({ ...input, action: 'list' });
    await pullRequests({ ...input, provider: 'gitea', action: 'view', number: 3 });
    await pullRequests({ ...input, provider: 'gitlab', action: 'create', title: 'Title', body: '', head: 'feature', base: 'main' });
    await expect(pullRequests({ ...input, remote: 'other', action: 'list' })).rejects.toThrow('existing remote');
    await expect(pullRequests({ ...input, action: 'merge', number: -1 })).rejects.toThrow('number');
    const calls = await readFile(log, 'utf8');
    expect(calls).toContain('--repo git.example.com/owner/repo');
    expect(calls).toContain('--login git.example.com --repo owner/repo');
    expect(calls).toContain('--repo https://git.example.com/owner/repo');
    expect(calls).toContain('--source-branch feature --target-branch main');
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});
