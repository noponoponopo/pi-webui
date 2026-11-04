import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startServer } from '../server/index';

test('dropped files are saved as separate persistent paths, with chunk and cancellation checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-webui-upload-'));
  const app = startServer({ port: 0, dataDir: root, bridgeSocket: join(root, 'bridge.sock'), cwd: root });
  const base = `http://127.0.0.1:${app.server.port}`;
  let stopped = false;
  const send = (id: string, name: string, offset: number, final: boolean, data: Uint8Array) => {
    const query = new URLSearchParams({ id, name, offset: String(offset), final: final ? '1' : '0' });
    return fetch(`${base}/api/files/upload?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(data),
    });
  };
  const cancel = (id: string) => fetch(`${base}/api/files/upload/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  try {
    await app.ready;
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 7).map((_, index) => index % 251);
    const first = await send(id, '画像 file.png', 0, false, bytes.slice(0, 8 * 1024 * 1024));
    expect(first.status).toBe(200);
    const { path } = await first.json();
    expect(basename(path)).toBe('画像 file.png');
    expect((await send(id, '画像 file.png', 1, true, bytes.slice(-7))).status).toBe(400);
    expect((await send(id, '画像 file.png', 8 * 1024 * 1024, true, bytes.slice(-7))).status).toBe(200);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));

    const duplicate = await send(crypto.randomUUID(), '画像 file.png', 0, true, new Uint8Array());
    const emptyPath = (await duplicate.json()).path;
    expect(emptyPath).not.toBe(path);
    expect((await stat(emptyPath)).size).toBe(0);
    expect((await send(crypto.randomUUID(), '../escape', 0, true, new Uint8Array())).status).toBe(400);

    const unfinished = crypto.randomUUID();
    const partial = (await (await send(unfinished, 'partial.txt', 0, false, new Uint8Array([1]))).json()).path;
    expect((await cancel(unfinished)).status).toBe(200);
    expect(await Bun.file(partial).exists()).toBe(false);
    await cancel(id);
    const interrupted = (await (await send(crypto.randomUUID(), 'interrupted.txt', 0, false, new Uint8Array([1]))).json()).path;
    await app.stop();
    stopped = true;
    expect(await Bun.file(interrupted).exists()).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  } finally {
    if (!stopped) await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
