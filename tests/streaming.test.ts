import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../server/history';
import { piStream } from '../server/index';
import { applyEvent, emptyProjection, mergeMessageDeltas, reconcileSnapshot } from '../shared/transcript';
import type { Message, PiEvent, PiUpdate, PiSnapshot } from '../shared/types';

const message = {
  role: 'assistant', content: [], timestamp: 1, stopReason: 'stop',
  api: 'anthropic-messages', provider: 'anthropic', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} satisfies Message;
const delta = (type: 'text_delta' | 'thinking_delta' | 'toolcall_delta', contentIndex: number, text: string): Extract<PiEvent, { type: 'message_update' }> => ({
  type: 'message_update', usage: message.usage,
  assistantMessageEvent: { type, contentIndex, delta: text },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('stream batching preserves text, tool arguments, ordering and final snapshots', async () => {
  let send!: (update: PiUpdate) => void;
  let cleaned = false;
  const reader = piStream((listener) => {
    send = listener;
    return () => { cleaned = true; };
  }).body!.getReader();
  const received: PiUpdate[] = [];
  const consume = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) received.push(JSON.parse(frame.slice(6)));
      }
    }
  })();
  const source: PiEvent[] = [];
  const emit = (event: PiEvent) => { source.push(event); send({ kind: 'event', value: event }); };
  try {
    emit({ type: 'message_start', message });
    for (let i = 0; i < 1000; i++) emit(delta('text_delta', 0, `${i} `));
    emit(delta('thinking_delta', 1, 'reason'));
    emit(delta('thinking_delta', 1, 'ing'));
    emit({ type: 'extension_ui_request', method: 'set_editor_text', id: 'editor', text: 'Keep this draft' });
    emit(delta('text_delta', 0, 'after editor'));
    await sleep(80);
    const events = received.flatMap((update) => update.kind === 'event' ? [update.value] : []);
    expect(events).toHaveLength(5);
    expect(events.reduce(applyEvent, emptyProjection())).toEqual(source.reduce(applyEvent, emptyProjection()));
    expect(events[3]).toMatchObject({ method: 'set_editor_text', text: 'Keep this draft' });
    const tool1 = { ...delta('toolcall_delta', 2, '{'), assistantMessageEvent: {
      type: 'toolcall_delta' as const, contentIndex: 2, delta: '{',
      toolCall: { type: 'toolCall' as const, id: 'tool', name: 'bash', arguments: {} },
    } } satisfies Extract<PiEvent, { type: 'message_update' }>;
    const tool2 = { ...tool1, assistantMessageEvent: {
      ...tool1.assistantMessageEvent, delta: '"command":"ls"}',
      toolCall: { type: 'toolCall' as const, id: 'tool', name: 'bash', arguments: { command: 'ls' } },
    } } satisfies Extract<PiEvent, { type: 'message_update' }>;
    const merged = mergeMessageDeltas(tool1, tool2)!;
    const initial = applyEvent(emptyProjection(), { type: 'message_start', message });
    expect(applyEvent(applyEvent(initial, tool1), tool2)).toEqual(applyEvent(initial, merged));
    expect(mergeMessageDeltas(delta('text_delta', 0, 'a'), delta('text_delta', 1, 'b'))).toBeUndefined();
    expect(mergeMessageDeltas(delta('text_delta', 0, 'a'.repeat(65536)), delta('text_delta', 0, 'b'))).toBeUndefined();
    expect(applyEvent(initial, { type: 'agent_end', messages: [], willRetry: false })).toBe(initial);
    emit(delta('text_delta', 0, 'superseded'));
    const snapshot = { state: {} as PiSnapshot['state'], transcript: source.reduce(applyEvent, emptyProjection()) };
    send({ kind: 'snapshot', value: snapshot });
    await sleep(80);
    expect(received.at(-1)).toEqual({ kind: 'snapshot', value: snapshot });
    const count = received.length;
    emit(delta('text_delta', 0, 'cancelled'));
    await reader.cancel();
    await sleep(80);
    expect(cleaned).toBe(true);
    expect(received).toHaveLength(count);
  } finally {
    await reader.cancel();
    await consume;
  }
});

test('canonical snapshots reuse only messages whose complete contents are unchanged', () => {
  const previous: PiSnapshot = {
    state: {} as PiSnapshot['state'],
    transcript: { ...emptyProjection(), items: [
      { id: 'one', message: { ...message, content: [{ type: 'text', text: 'Original' }] } },
      { id: 'two', message: { ...message, content: [{ type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'ls' } }] } },
    ] },
  };
  const identical = structuredClone(previous);
  expect(reconcileSnapshot(previous, identical).transcript.items).toBe(previous.transcript.items);
  const changed = structuredClone(previous);
  changed.transcript.items[1].message = { ...message, content: [{ type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'pwd' } }] };
  const result = reconcileSnapshot(previous, changed);
  expect(result).toEqual(changed);
  expect(result.transcript.items[0]).toBe(previous.transcript.items[0]);
  expect(result.transcript.items[1]).toBe(changed.transcript.items[1]);
  const branch = { ...changed, transcript: { ...changed.transcript, items: changed.transcript.items.slice(0, 1) } };
  expect(reconcileSnapshot(previous, branch)).toEqual(branch);
});

test('history and SSE preserve sessions larger than 32 MiB, including images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-webui-history-'));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const image = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(33 * 1024 * 1024) };
    const file = join(root, 'session.jsonl');
    await writeFile(file, [
      { type: 'session', version: 3, id: 'large', cwd: root },
      { type: 'message', id: 'first', parentId: null, timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Keep the whole history' }, image], timestamp: 1 } },
      { type: 'message', id: 'last', parentId: 'first', timestamp: '2025-01-01T00:00:01Z',
        message: { ...message, content: [{ type: 'text', text: 'Still visible' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\ninvalid trailing record');
    const saved = await readHistory(file);
    expect(saved.transcript.items).toHaveLength(2);
    let send!: (update: PiUpdate) => void;
    let cleaned = false;
    reader = piStream((listener) => {
      send = listener;
      return () => { cleaned = true; };
    }).body!.getReader();
    const next = reader.read();
    send({ kind: 'snapshot', value: { state: {} as PiSnapshot['state'], transcript: saved.transcript } });
    const frame = new TextDecoder().decode((await next).value);
    expect(frame.startsWith('data: ')).toBe(true);
    const update = JSON.parse(frame.slice(6)) as Extract<PiUpdate, { kind: 'snapshot' }>;
    expect(update.value.transcript).toEqual(saved.transcript);
    expect(cleaned).toBe(false);
    await reader.cancel();
    expect(cleaned).toBe(true);
  } finally {
    await reader?.cancel();
    await rm(root, { recursive: true, force: true });
  }
});
