import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index';

test('Tailscale HTTPS origin works while other hosts and cross-site requests are denied', async () => {
  const previous = process.env.PI_WEBUI_PUBLIC_ORIGIN;
  const origin = 'https://device.example.ts.net';
  process.env.PI_WEBUI_PUBLIC_ORIGIN = origin;
  const root = mkdtempSync(join(tmpdir(), 'pi-webui-network-'));
  let app: ReturnType<typeof startServer> | undefined;
  try {
    app = startServer({ port: 0, dataDir: root, bridgeSocket: join(root, 'bridge.sock'), cwd: root });
    await app.ready;
    const url = `http://127.0.0.1:${app.server.port}/api/health`;
    const request = (headers: Record<string, string> = {}) => fetch(url, { headers });
    expect((await request()).status).toBe(200);
    expect((await request({ Host: new URL(origin).host, Origin: origin })).status).toBe(200);
    expect((await request({ Origin: origin })).status).toBe(200);
    expect((await request({ Host: 'attacker.example' })).status).toBe(403);
    expect((await request({ Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await request({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await request({ Origin: origin.replace('https:', 'http:') })).status).toBe(403);
    const navigation = {
      Host: new URL(origin).host,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    };
    expect((await fetch(new URL('/', url), { headers: navigation })).status).toBe(200);
    expect((await request(navigation)).status).toBe(403);
    expect((await fetch(new URL('/', url), {
      headers: { ...navigation, 'Sec-Fetch-Dest': 'iframe' },
    })).status).toBe(403);
  } finally {
    await app?.stop();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_WEBUI_PUBLIC_ORIGIN;
    else process.env.PI_WEBUI_PUBLIC_ORIGIN = previous;
  }
});
