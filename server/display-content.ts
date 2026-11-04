import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, PiUpdate, PiSnapshot, TranscriptItem } from '../shared/types';

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

/** Passes content through complete; only rewrites base64 images to cached URLs. */
export class DisplayContent {
  private messages = new WeakMap<object, Message>();

  constructor(readonly directory: string) {}

  private put(value: string | Buffer, extension: string): string {
    const id = createHash('sha256').update(value).digest('hex') + '.' + extension;
    const path = join(this.directory, id);
    if (!existsSync(path)) {
      const temporary = path + '.' + randomUUID();
      writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    }
    return `/api/pi/content/${id}`;
  }

  private images(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.images(item));
    const object = value as Record<string, unknown>;
    if (object.type === 'image' && typeof object.data === 'string' && object.data &&
        typeof object.mimeType === 'string' && IMAGE_TYPES[object.mimeType]) {
      return { ...object, data: '', url: this.put(Buffer.from(object.data, 'base64'), IMAGE_TYPES[object.mimeType]) };
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, this.images(item)]));
  }

  message(message: Message, cache = true): Message {
    const cached = cache && this.messages.get(message);
    if (cached) return cached;
    const result = this.images(message) as Message;
    if (cache) this.messages.set(message, result);
    return result;
  }

  async search(items: TranscriptItem[], query: string, signal?: AbortSignal): Promise<TranscriptItem[]> {
    const matches: TranscriptItem[] = [];
    const needle = query.toLowerCase();
    for (const item of items) {
      signal?.throwIfAborted();
      const message = this.message(item.message);
      if (JSON.stringify(message).toLowerCase().includes(needle))
        matches.push({ ...item, message });
    }
    return matches;
  }

  private progress(value: unknown): unknown {
    try { return this.images(value); }
    catch (error) {
      if (!(error as NodeJS.ErrnoException).code) throw error;
      return value;
    }
  }

  snapshot(snapshot: PiSnapshot): PiSnapshot {
    return (this.update({ kind: 'snapshot', value: snapshot }) as Extract<PiUpdate, { kind: 'snapshot' }>).value;
  }

  update(update: PiUpdate): PiUpdate {
    if (update.kind === 'state') return update;
    if (update.kind === 'snapshot') return {
      ...update,
      value: { ...update.value, transcript: {
        ...update.value.transcript,
        items: update.value.transcript.items.map((item) => ({ ...item, message: this.message(item.message) })),
        partial: update.value.transcript.partial && this.message(update.value.transcript.partial, false),
        tools: this.progress(update.value.transcript.tools) as typeof update.value.transcript.tools,
      } },
    };
    const event = update.value;
    if (event.type === 'message_start' || event.type === 'message_end')
      return { ...update, value: { ...event, message: this.message(event.message, event.type === 'message_end') } };
    // Finalized messages have their own events; do not resend the complete context.
    if (event.type === 'agent_end') return { ...update, value: { ...event, messages: [] } };
    if (event.type === 'turn_end') return { ...update, value: {
      ...event, message: this.message(event.message), toolResults: [],
    } };
    // Deltas remain incremental; tool output images are rewritten as they arrive.
    if (event.type.startsWith('tool_execution_') || event.type === 'message_update' ||
        event.type === 'entry_appended' || event.type === 'bash_execution_update')
      return { ...update, value: this.progress(event) as typeof event };
    return update;
  }
}
