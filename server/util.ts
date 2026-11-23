import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, createGzip } from 'node:zlib';

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const expandHome = (path: string) =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

const compressible = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

export const acceptsGzip = (request: Request, type: string) =>
  compressible.test(type) && /\bgzip\b/.test(request.headers.get('Accept-Encoding') ?? '');

export function gzip(request: Request, response: Response) {
  if (
    !response.body ||
    response.headers.has('Content-Encoding') ||
    !acceptsGzip(request, response.headers.get('Content-Type') ?? '')
  )
    return response;
  // Sync flush per chunk keeps SSE frames deliverable immediately.
  const gz = createGzip({ flush: constants.Z_SYNC_FLUSH });
  let out!: TransformStreamDefaultController<Uint8Array>;
  gz.on('data', (chunk: Uint8Array) => out.enqueue(chunk));
  gz.on('error', (error) => out.error(error));
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        out = controller;
      },
      transform: (chunk) =>
        new Promise((resolve, reject) => gz.write(chunk, (error) => (error ? reject(error) : resolve()))),
      flush: () =>
        new Promise((resolve) => {
          gz.once('end', resolve);
          gz.end();
        }),
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Content-Encoding', 'gzip');
  headers.append('Vary', 'Accept-Encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
