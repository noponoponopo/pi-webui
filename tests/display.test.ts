import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index';
import { DisplayContent } from '../server/display-content';
import { applyDisplayEvent, DISPLAY_PAGE_SIZE, reconcileHistory, transcriptPage } from '../shared/display';
import { emptyProjection, messageText } from '../shared/transcript';
import type { Message, PiUpdate, TranscriptPage } from '../shared/types';

const assistant = (text: string): Message => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 1, stopReason: 'stop',
  api: 'anthropic-messages', provider: 'anthropic', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test('large saved histories page without sending base64, and deferred content remains complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-webui-display-'));
  const text = '界😀'.repeat(40_000) + 'Hidden needle';
  const image = 'A'.repeat(33 * 1024 * 1024);
  const file = join(root, 'session.jsonl');
  const entries = Array.from({ length: 301 }, (_, index) => index === 0
    ? { type: 'session', version: 3, id: 'display-test', cwd: root }
    : { type: 'message', id: String(index), parentId: index === 1 ? null : String(index - 1),
      timestamp: '2025-01-01T00:00:00Z', message: index === 300 ? assistant(text) : {
        role: 'user', timestamp: index, content: index === 1 ? [
          { type: 'text', text: 'Old image' }, { type: 'image', mimeType: 'image/png', data: image },
        ] : `Message ${index}`,
      } });
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const original = Bun.hash(await readFile(file));
  const app = startServer({ port: 0, dataDir: root, agentDir: join(root, 'agent'), bridgeSocket: join(root, 'bridge.sock'), cwd: root });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await app.ready;
    const row = await app.bridge.watch(file);
    const base = `http://127.0.0.1:${app.server.port}`;
    const stream = async () => {
      const response = await fetch(`${base}/api/pi/${encodeURIComponent(row.id)}/stream`);
      const current = response.body!.getReader();
      reader = current;
      let frame = '';
      const decoder = new TextDecoder();
      while (!frame.includes('\n\n')) frame += decoder.decode((await current.read()).value, { stream: true });
      return (JSON.parse(frame.slice(6)) as Extract<PiUpdate, { kind: 'snapshot' }>).value;
    };
    const snapshot = await stream();
    expect(snapshot.transcript.items).toHaveLength(DISPLAY_PAGE_SIZE);
    expect(snapshot.transcript.total).toBe(300);
    let page: TranscriptPage = { items: snapshot.transcript.items, before: snapshot.transcript.before, total: 300 };
    const all = [...page.items];
    while (page.before) {
      const response = await fetch(`${base}/api/pi/${encodeURIComponent(row.id)}/messages?before=${page.before}`);
      expect(response.status).toBe(200);
      page = await response.json() as TranscriptPage;
      expect(page.items.length).toBeLessThanOrEqual(DISPLAY_PAGE_SIZE);
      all.unshift(...page.items);
    }
    expect(all.map((item) => item.id)).toEqual(Array.from({ length: 300 }, (_, index) => String(index + 1)));
    const imageBlock = (all[0].message as any).content[1];
    expect(imageBlock.data).toBe('');
    const imageResponse = await fetch(base + imageBlock.url);
    expect(imageResponse.headers.get('content-type')).toBe('image/png');
    expect((await imageResponse.arrayBuffer()).byteLength).toBe(image.length / 4 * 3);
    const search = await fetch(`${base}/api/pi/${encodeURIComponent(row.id)}/messages?q=hidden%20needle`);
    const found = await search.json() as TranscriptPage;
    expect(found.total).toBe(1);
    expect(found.items[0].id).toBe('300');
    const earlier = await fetch(`${base}/api/pi/${encodeURIComponent(row.id)}/messages?q=Old%20image`);
    expect((await earlier.json() as TranscriptPage).items[0].id).toBe('1');
    expect(messageText(all.at(-1)!.message)).toBe(text);
    expect((await fetch(`${base}/api/pi/content/${'0'.repeat(64)}.txt`)).status).toBe(404);
    expect((await fetch(`${base}/api/pi/${encodeURIComponent(row.id)}/messages?before=missing`)).status).toBe(400);
    await reader!.cancel();
    expect((await stream()).transcript.items).toEqual(snapshot.transcript.items);
    expect(Bun.hash(await readFile(file))).toBe(original);
  } finally {
    await reader?.cancel();
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('live history replaces rewound tails while preserving loaded ancestors', () => {
  const items = Array.from({ length: 300 }, (_, index) => ({
    id: String(index), message: assistant(String(index)),
  }));
  const loaded: TranscriptPage = { items: items.slice(60), before: '60', total: 300 };
  const latest = (messages: typeof items) => ({ ...emptyProjection(), ...transcriptPage(messages) });
  const advanced = [...items, { id: '300', message: assistant('new') }];
  expect(reconcileHistory(loaded, latest(advanced))).toEqual({
    items: advanced.slice(60), before: '60', total: 301,
  });
  expect(reconcileHistory(loaded, latest(items.slice(0, 240)))).toEqual({
    items: items.slice(60, 240), before: '60', total: 240,
  });
  const short = latest(items.slice(0, 30));
  expect(reconcileHistory(loaded, short)).toEqual(transcriptPage(items.slice(0, 30)));
  expect(reconcileHistory(loaded, latest([]))).toEqual(transcriptPage([]));
  const other = items.map((item) => ({ ...item, id: `other-${item.id}` }));
  expect(reconcileHistory(loaded, latest(other))).toEqual(transcriptPage(other));
  const fork = [...items.slice(0, 230), { id: 'fork', message: assistant('branch') }];
  expect(reconcileHistory(loaded, latest(fork))).toEqual({
    items: fork.slice(60), before: '60', total: 231,
  });
});

test('display copies do not alter agent input, and live windows stay bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-webui-display-unit-'));
  try {
    const display = new DisplayContent(root);
    const original = assistant('x'.repeat(100_000));
    const saved = structuredClone(original);
    const copy = display.message(original);
    expect(original).toEqual(saved);
    expect(copy).toEqual(saved);
    expect(display.message(original)).toBe(copy);
    let projection = applyDisplayEvent(emptyProjection(), { type: 'message_start', message: assistant('') });
    for (let index = 0; index < 500; index++) projection = applyDisplayEvent(projection, { type: 'message_end', message: assistant(String(index)) });
    expect(projection.items).toHaveLength(DISPLAY_PAGE_SIZE);
    expect(new Set(projection.items.map((item) => item.id)).size).toBe(DISPLAY_PAGE_SIZE);
    expect(projection.total).toBe(500);
    expect(projection.before).toBe(projection.items[0].id);
    expect(transcriptPage([])).toEqual({ items: [], before: undefined, total: 0 });
    expect(() => transcriptPage(projection.items, 'missing')).toThrow('History changed');
    const withTool = { ...projection, tools: { call: { name: 'bash', args: {}, running: false } } };
    const completed = applyDisplayEvent(withTool, { type: 'message_end', message: {
      role: 'toolResult', toolCallId: 'call', toolName: 'bash', isError: false,
      content: [{ type: 'text', text: 'Finished' }], timestamp: 2,
    } });
    expect(completed.tools).toEqual({});
    expect(Object.keys(withTool.tools)).toEqual(['call']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
