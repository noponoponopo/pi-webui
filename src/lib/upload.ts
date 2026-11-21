import { api } from './api';

const CHUNK_SIZE = 8 * 1024 * 1024;

export async function uploadFile(file: File, signal: AbortSignal): Promise<string> {
  const id = crypto.randomUUID();
  let offset = 0;
  try {
    let path = '';
    do {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const query = new URLSearchParams({
        id, name: file.name, offset: String(offset), final: end === file.size ? '1' : '0',
      });
      const response = await fetch(`/api/files/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, end),
        signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      path = (await response.json()).path;
      offset = end;
    } while (offset < file.size);
    return path;
  } catch (error) {
    void api('/files/upload/cancel', { id }).catch(() => {});
    throw error;
  }
}
