import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 43147;
export function stateDirectory() {
  const legacy = join(homedir(), '.local/state/pi-web');
  return process.env.PI_WEBUI_DATA_DIR ||
    (existsSync(legacy) ? legacy : join(homedir(), '.local/state/pi-webui'));
}
export type RuntimeInfo = { pid: number; url: string };

export function listenLocal(
  options: Bun.Serve.Options<undefined> & { unix?: undefined },
  preferredPort = DEFAULT_PORT,
) {
  const settings = {
    ...options,
    hostname: '127.0.0.1',
    port: options.port ?? preferredPort,
  };
  try {
    return Bun.serve(settings);
  } catch (error) {
    if (
      options.port !== undefined ||
      (error as NodeJS.ErrnoException).code !== 'EADDRINUSE'
    )
      throw error;
    return Bun.serve({ ...settings, port: 0 });
  }
}

export function readRuntime(root = stateDirectory()): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function publishRuntime(url: string, root = stateDirectory()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'runtime.json');
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, url }), {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
  return () => {
    if (readRuntime(root)?.pid === process.pid) unlinkSync(file);
  };
}

export async function liveRuntime(
  root = stateDirectory(),
): Promise<RuntimeInfo | undefined> {
  const runtime = readRuntime(root);
  if (!runtime || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url)) return;
  try {
    const health = await fetch(`${runtime.url}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }).then((r) => r.json());
    if (health.service === 'pi-webui' && health.pid === runtime.pid)
      return runtime;
  } catch {}
}
