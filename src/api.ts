import { useEffect, useRef, useState } from 'react';

export async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const content = await response.text();
    let message = content;
    try {
      message = JSON.parse(content).error || content;
    } catch {
      /* Non-JSON network errors keep their original text. */
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

export function useStream<T>(
  path: string | undefined,
  onUpdate: (updates: T[]) => void,
  onError?: (message: string) => void,
  { batchMs = 0 } = {},
) {
  const update = useRef(onUpdate);
  update.current = onUpdate;
  const error = useRef(onError);
  error.current = onError;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setConnected(false);
    if (!path) return;
    let source: EventSource | undefined;
    let halted = false;
    let lastTick = Date.now();
    let pending: T[] = [];
    let batch: ReturnType<typeof setTimeout> | undefined;
    const clearBatch = () => {
      clearTimeout(batch);
      batch = undefined;
      pending = [];
    };
    const flush = () => {
      const values = pending;
      clearBatch();
      if (values.length) update.current(values);
    };
    const connect = () => {
      if (halted) return;
      flush();
      source?.close();
      setConnected(false);
      lastTick = Date.now();
      const next = new EventSource(`/api${path}`);
      source = next;
      next.onopen = () => {
        if (!halted && source === next) setConnected(true);
      };
      next.onerror = () => {
        if (!halted && source === next) setConnected(false);
      };
      next.onmessage = (event) => {
        if (halted || source !== next) return;
        const value = JSON.parse(event.data) as T;
        if (!batchMs) update.current([value]);
        else {
          pending.push(value);
          batch ??= setTimeout(flush, batchMs);
        }
      };
      next.addEventListener('stream_error', (event) => {
        if (halted || source !== next) return;
        halted = true;
        flush();
        next.close();
        setConnected(false);
        error.current?.(JSON.parse((event as MessageEvent).data));
      });
    };
    const resume = () => {
      if (!document.hidden) {
        if (!source || source.readyState === EventSource.CLOSED || Date.now() - lastTick > 30_000) connect();
        else flush();
      }
    };
    connect();
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (!document.hidden && now - lastTick > 30_000) connect();
      lastTick = now;
    }, 15_000);
    return () => {
      halted = true;
      source?.close();
      clearBatch();
      window.clearInterval(timer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [path, batchMs]);
  return connected;
}

export const basename = (path: string) =>
  path.split('/').filter(Boolean).at(-1) || path;
export function age(time: number) {
  const minutes = Math.max(0, (Date.now() - time) / 60_000);
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${Math.floor(minutes)}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
