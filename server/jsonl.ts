import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { PassThrough, type Readable, type Writable } from 'node:stream';

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function guardJsonlFrames(socket: Socket): PassThrough {
  const output = new PassThrough({ highWaterMark: MAX_BUFFERED_BYTES });
  let frameBytes = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      frameBytes += i - start + 1;
      if (frameBytes > MAX_FRAME_BYTES) {
        const error = new Error('Bridge JSONL frame exceeds 32 MiB');
        output.destroy(error);
        socket.destroy(error);
        return;
      }
      frameBytes = 0;
      start = i + 1;
    }
    frameBytes += chunk.length - start;
    if (frameBytes > MAX_FRAME_BYTES) {
      const error = new Error('Bridge JSONL frame exceeds 32 MiB');
      output.destroy(error);
      socket.destroy(error);
      return;
    }
    if (!output.write(chunk)) socket.pause();
  });
  output.on('drain', () => socket.resume());
  socket.on('end', () => output.end());
  socket.on('error', (error) => output.destroy(error));
  return output;
}

export class JsonlConnection {
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = '';
  private bufferedBytes = 0;
  private closed?: Error;
  onEvent: (event: unknown) => void = () => {};
  onClose: (error: Error) => void = () => {};

  constructor(
    private input: Writable,
    output: Readable,
  ) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      this.bufferedBytes += Buffer.byteLength(chunk);
      for (let end; (end = this.buffer.indexOf('\n')) !== -1; ) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const bytes = Buffer.byteLength(line);
        this.bufferedBytes -= bytes + 1;
        if (bytes > MAX_FRAME_BYTES)
          return this.close(new Error('RPC record exceeds 32 MiB'));
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          this.close(new Error('Invalid JSON from backend'));
          return;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          this.close(new Error('Invalid RPC record'));
          return;
        }
        const pending = this.pending.get(record.id);
        if (
          pending &&
          (record.type === 'response' ||
            'result' in record ||
            'error' in record)
        ) {
          this.pending.delete(record.id);
          if (record.success === false || record.error)
            pending.reject(
              new Error(
                typeof record.error === 'string'
                  ? record.error
                  : (record.error?.message ?? 'RPC failed'),
              ),
            );
          else
            pending.resolve(
              record.type === 'response' ? record.data : record.result,
            );
        } else this.onEvent(record);
      }
      if (this.bufferedBytes > 32 * 1024 * 1024)
        this.close(new Error('RPC record exceeds 32 MiB'));
    });
    output.on('end', () => this.close(new Error('Backend disconnected')));
    output.on('error', (error) => this.close(error));
    input.on('error', (error) => this.close(error));
  }

  write(record: object): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.input.write(`${JSON.stringify(record)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  request<T>(record: object, timeout = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'Backend request timed out; the operation may still be running',
          ),
        );
      }, timeout);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ ...record, id }).catch((error) => {
        this.pending.get(id)?.reject(error);
        this.pending.delete(id);
      });
    });
  }

  close(error = new Error('Connection closed')) {
    if (this.closed) return;
    this.closed = error;
    this.buffer = '';
    this.bufferedBytes = 0;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onClose(error);
  }
}
