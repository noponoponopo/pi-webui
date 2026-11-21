import { join } from 'node:path';

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

export async function displayResponse(directory: string, id: string): Promise<Response> {
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(id) || !await Bun.file(join(directory, id)).exists())
    return new Response('Not found', { status: 404 });
  return new Response(Bun.file(join(directory, id)), { headers: {
    'Content-Type': TYPES[id.split('.').at(-1)!],
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
