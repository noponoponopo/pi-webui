import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { liveRuntime, stateDirectory } from '../server/local-runtime';

export const SERVICE_LABEL = 'dev.pi-webui';
const domain = () => `gui/${process.getuid!()}`;
const target = () => `${domain()}/${SERVICE_LABEL}`;
const serviceFile = () =>
  join(homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function managedFile(
  path: string,
  content: string,
  marker: string,
  mode = 0o600,
) {
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(marker))
    throw new Error(`Refusing to overwrite unmanaged file: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

export function launchAgent(
  root: string,
  bun: string,
  env: Record<string, string>,
) {
  const logs = join(stateDirectory(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- pi-webui managed service -->
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(join(root, 'dist/server.js'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'server.error.log'))}</string>
</dict></plist>\n`;
}

export function installLauncher(root: string) {
  const bin = join(homedir(), '.local/bin/pi-webui');
  managedFile(
    bin,
    `#!/bin/sh\n# pi-webui managed launcher\nexec ${quote(process.execPath)} ${quote(join(root, 'dist/cli.js'))} "$@"\n`,
    '# pi-webui managed launcher',
    0o700,
  );
  return bin;
}

function macOS() {
  if (process.platform !== 'darwin')
    throw new Error(
      'Automatic service management requires macOS. Use pi-webui serve on other systems.',
    );
}
function launchctl(...args: string[]) {
  const result = Bun.spawnSync(['/bin/launchctl', ...args]);
  if (result.exitCode)
    throw new Error(
      result.stderr.toString().trim() || `launchctl ${args[0]} failed`,
    );
}
const loaded = () =>
  Bun.spawnSync(['/bin/launchctl', 'print', target()]).exitCode === 0;

export function installService(root: string) {
  macOS();
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH || '/usr/bin:/bin',
    PI_WEBUI_CWD: process.env.PI_WEBUI_CWD || homedir(),
  };
  for (const key of [
    'PI_WEBUI_PORT',
    'PI_WEBUI_PUBLIC_ORIGIN',
    'PI_WEBUI_DATA_DIR',
    'PI_WEBUI_SOCKET',
    'PI_CODING_AGENT_DIR',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  mkdirSync(join(stateDirectory(), 'logs'), { recursive: true, mode: 0o700 });
  managedFile(
    serviceFile(),
    launchAgent(root, process.execPath, env),
    '<!-- pi-webui managed service -->',
  );
  launchctl('enable', target());
}

export async function startService() {
  macOS();
  if (!existsSync(serviceFile())) throw new Error('Run pi-webui setup first.');
  const existing = await liveRuntime();
  if (existing) return existing;
  launchctl('enable', target());
  if (!loaded()) launchctl('bootstrap', domain(), serviceFile());
  for (let i = 0; i < 100; i++) {
    const runtime = await liveRuntime();
    if (runtime) return runtime;
    await Bun.sleep(150);
  }
  throw new Error(
    `Service did not become ready; see ${join(stateDirectory(), 'logs/server.error.log')}`,
  );
}

export async function stopService(force = false) {
  macOS();
  const runtime = await liveRuntime();
  if (runtime && !force) {
    const catalog = await fetch(`${runtime.url}/api/bootstrap`).then((r) =>
      r.json(),
    );
    if (
      catalog.sessions.some(
        (s: { kind: string; running: boolean; waiting: boolean }) =>
          s.kind !== 'cli' && (s.running || s.waiting),
      )
    )
      throw new Error(
        'A Web session is active. Wait for it, or use --force to interrupt it. Native CLIs are not stopped.',
      );
  }
  if (loaded()) launchctl('bootout', target());
  else if (runtime) process.kill(runtime.pid, 'SIGTERM');
  if (!runtime) return;
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(runtime.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await Bun.sleep(150);
  }
  throw new Error(
    'The previous server has not exited; refusing to start a second one.',
  );
}

export async function disableService(force = false) {
  await stopService(force);
  launchctl('disable', target());
}
