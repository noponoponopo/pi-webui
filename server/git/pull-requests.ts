import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitStatus, gitHistory } from './git';

const exec = promisify(execFile);
type Provider = 'github' | 'gitea' | 'gitlab';
type Action = 'list' | 'view' | 'diff' | 'create' | 'close' | 'reopen' | 'merge' | 'edit';
export type PullRequestInput = {
  cwd: string; remote: string; provider: string; action: string;
  number?: number; title?: string; body?: string; base?: string; head?: string;
};

async function run(command: string, args: string[], cwd: string) {
  try {
    const result = await exec(command, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GLAB_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    return result.stdout;
  } catch (error) {
    const e = error as Error & { stderr?: string; code?: string };
    if (e.code === 'ENOENT') throw new Error(`${command} is not installed`);
    throw new Error(`${command}: ${e.stderr?.trim() || e.message}`);
  }
}

function parseRepository(value: string) {
  let url: URL;
  if (/^(?:[^/@:]+@)?[^/:]+:/.test(value) && !value.includes('://')) {
    const match = value.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/)!;
    url = new URL(`ssh://${match[1]}/${match[2]}`);
  } else {
    try { url = new URL(value); } catch { throw new Error('Remote must be an SSH or HTTP Git URL'); }
  }
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.hostname.startsWith('-') || url.search || url.hash) throw new Error('Unsupported remote URL');
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!path.includes('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid remote repository');
  const host = url.protocol === 'ssh:' ? url.hostname : url.host;
  return { host, path, protocol: url.protocol };
}

export async function pullRequests(input: PullRequestInput) {
  const { cwd, remote } = input;
  const provider = input.provider as Provider;
  const action = input.action as Action;
  if (!['github', 'gitea', 'gitlab'].includes(provider) || !['list', 'view', 'diff', 'create', 'close', 'reopen', 'merge', 'edit'].includes(action)) throw new Error('Invalid pull request operation');
  const status = await getGitStatus(cwd);
  if (!status.isRepo) throw new Error('Not a Git repository');
  const history = await gitHistory(status.root);
  if (!history.remotes?.includes(remote)) throw new Error('Select an existing remote');
  const remoteUrl = (await run('git', ['remote', 'get-url', '--', remote], status.root)).trim();
  const repository = parseRepository(remoteUrl);
  let host = repository.host;
  if (repository.protocol === 'ssh:' && provider !== 'gitea') {
    const config = await run('ssh', ['-G', host], status.root);
    host = config.match(/^hostname (.+)$/m)?.[1] ?? host;
  }
  const repoName = `${host}/${repository.path}`;
  const repoUrl = `${repository.protocol === 'http:' ? 'http:' : 'https:'}//${repoName}`;
  if (!['list', 'create'].includes(action) && (!Number.isSafeInteger(input.number) || input.number! < 1)) throw new Error('Invalid pull request number');
  const number = String(input.number ?? '');
  if (['create', 'edit'].includes(action)) {
    if (!input.title?.trim() || input.title.length > 500 || typeof input.body !== 'string' || input.body.length > 50_000) throw new Error('Enter a valid title and description');
    if (provider === 'gitlab' && input.body === '-') throw new Error('GitLab CLI treats a single dash as an editor request');
    if (action === 'create' && (!input.head?.trim() || !input.base?.trim() || input.head.length > 1024 || input.base.length > 1024 || input.head.startsWith('-') || input.base.startsWith('-'))) throw new Error('Enter source and target branches');
  }
  let command: string;
  let args: string[];
  if (provider === 'github') {
    command = 'gh';
    const repo = ['--repo', repoName];
    const fields = 'number,title,state,url,body,headRefName,baseRefName,author,mergeable,reviewDecision';
    if (action === 'list') args = ['pr', 'list', ...repo, '--state', 'all', '--limit', '100', '--json', fields];
    else if (action === 'view') args = ['pr', 'view', number, ...repo, '--json', fields];
    else if (action === 'diff') args = ['pr', 'diff', number, ...repo];
    else if (action === 'create') args = ['pr', 'create', ...repo, '--title', input.title!, '--body', input.body!, '--head', input.head!, '--base', input.base!];
    else if (action === 'edit') args = ['pr', 'edit', number, ...repo, '--title', input.title!, '--body', input.body!];
    else args = ['pr', action, number, ...repo, ...(action === 'merge' ? ['--merge'] : [])];
  } else if (provider === 'gitlab') {
    command = 'glab';
    const repo = ['--repo', repoUrl];
    if (action === 'list') args = ['mr', 'list', ...repo, '--all', '--per-page', '100', '--output', 'json'];
    else if (action === 'view') args = ['mr', 'view', number, ...repo, '--output', 'json'];
    else if (action === 'diff') args = ['mr', 'diff', number, ...repo];
    else if (action === 'create') args = ['mr', 'create', ...repo, '--title', input.title!, '--description', input.body!, '--source-branch', input.head!, '--target-branch', input.base!, '--yes'];
    else if (action === 'edit') args = ['mr', 'update', number, ...repo, '--title', input.title!, '--description', input.body!];
    else args = ['mr', action, number, ...repo, ...(action === 'merge' ? ['--yes'] : [])];
  } else {
    command = 'tea';
    const logins = JSON.parse(await run('tea', ['login', 'list', '--output', 'json'], status.root)) as { name?: string; url?: string }[];
    const matches = logins.filter((login) => login.name === host || (login.url && new URL(login.url).host === host));
    if (matches.length !== 1 || !matches[0].name) throw new Error('Select a unique tea login matching the remote host or SSH alias');
    const repo = ['--login', matches[0].name, '--repo', repository.path];
    if (action === 'list') args = ['pulls', 'list', ...repo, '--state', 'all', '--limit', '100', '--output', 'json'];
    else if (action === 'view') args = ['pulls', ...repo, '--output', 'json', '--fields', 'index,title,state,url,body,head,base,author,mergeable', number];
    else if (action === 'diff') args = ['api', ...repo, `repos/{owner}/{repo}/pulls/${number}.diff`];
    else if (action === 'create') args = ['pulls', 'create', ...repo, '--title', input.title!, '--description', input.body!, '--head', input.head!, '--base', input.base!];
    else if (action === 'edit') args = ['pulls', 'edit', ...repo, '--title', input.title!, '--description', input.body!, number];
    else args = ['pulls', action, ...repo, number];
  }
  const output = await run(command, args, status.root);
  if (action === 'list' || action === 'view') {
    try { return { data: JSON.parse(output) as unknown }; }
    catch { throw new Error(`${command} returned invalid JSON`); }
  }
  return { output: output.trim() };
}
