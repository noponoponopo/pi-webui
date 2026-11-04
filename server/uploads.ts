import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

type Upload = { directory: string; path: string; offset: number; busy: boolean };

export class Uploads {
  private active = new Map<string, Upload>();

  constructor(private root: string) {}

  async write(request: Request, url: URL) {
    const id = url.searchParams.get('id') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const offsetText = url.searchParams.get('offset') ?? '';
    const offset = Number(offsetText);
    const final = url.searchParams.get('final');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        !name || name === '.' || name === '..' || /[/\\\0]/.test(name) ||
        !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) ||
        !['0', '1'].includes(final ?? ''))
      throw new Error('Invalid upload');
    if (request.headers.get('content-type') !== 'application/octet-stream')
      throw new Error('Binary upload required');

    let upload = this.active.get(id);
    if (!upload) {
      if (offset !== 0) throw new Error('Upload not found');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = join(this.root, id);
      await mkdir(directory, { mode: 0o700 });
      upload = { directory, path: join(directory, name), offset: 0, busy: false };
      this.active.set(id, upload);
    }
    if (upload.busy || upload.offset !== offset || upload.path !== join(upload.directory, name))
      throw new Error('Upload is out of sequence');
    upload.busy = true;
    try {
      const chunk = await request.arrayBuffer();
      if (this.active.get(id) !== upload) throw new Error('Upload cancelled');
      await appendFile(upload.path, new Uint8Array(chunk), { mode: 0o600 });
      upload.offset += chunk.byteLength;
      if (final === '1') this.active.delete(id);
      return { path: upload.path };
    } catch (error) {
      await this.cancel(id);
      throw error;
    } finally {
      upload.busy = false;
    }
  }

  async cancel(id: string) {
    const upload = this.active.get(id);
    if (!upload) return;
    this.active.delete(id);
    await rm(upload.directory, { recursive: true, force: true });
  }

  async stop() {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
  }
}
