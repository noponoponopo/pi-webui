import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  parseSessionEntries,
  migrateSessionEntries,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { activeHistory, emptyProjection } from '../shared/transcript';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HistoryRow } from '../shared/types';

const cache = new Map<
  string,
  { mtime: number; size: number; row: HistoryRow }
>();

export async function sessionMetadata(path: string): Promise<HistoryRow | undefined> {
  const info = await stat(path);
  const saved = cache.get(path);
  if (saved?.mtime === info.mtimeMs && saved.size === info.size)
    return saved.row;
  let cwd = '',
    id = '',
    name = '',
    first = '';
  let hasMessages = false;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Only metadata and the first user message matter. Never accumulate transcript text.
    if (
      id &&
      !line.includes('"session_info"') &&
      (first || !line.includes('"user"'))
    )
      continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session') {
        cwd = entry.cwd;
        id = entry.id;
      }
      if (entry.type === 'session_info') name = entry.name || '';
      if (entry.type === 'message' && entry.message?.role === 'user') {
        hasMessages = true;
        if (first) continue;
        const content = entry.message.content;
        first = (
          typeof content === 'string'
            ? content
            : content
                .filter((block: { type: string }) => block.type === 'text')
                .map((block: { text: string }) => block.text)
                .join(' ')
        )
          .trim()
          .split('\n')[0]
          .slice(0, 80);
      }
    } catch {
      /* Ignore incomplete/corrupt entries, as Pi's session reader does. */
    }
  }
  if (!id || !cwd) return;
  const row = {
    id,
    path,
    cwd,
    name: name || first || `Session ${id.slice(0, 8)}`,
    updatedAt: info.mtimeMs,
    hasMessages,
  };
  cache.set(path, { mtime: info.mtimeMs, size: info.size, row });
  return row;
}

// Saved history is a read-only preview, never a source of streaming tokens.
export async function readHistory(path: string) {
  if ((await stat(path)).size > 32 * 1024 * 1024)
    throw new Error('Saved history exceeds the 32 MiB display limit');
  let content = '',
    bytes = 0;
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 32 * 1024 * 1024)
      throw new Error('Saved history exceeds the 32 MiB display limit');
    content += chunk;
  }
  const entries = parseSessionEntries(content);
  const header = entries[0];
  if (header?.type !== 'session' || !header.id || !header.cwd)
    throw new Error('Invalid Pi session history');
  migrateSessionEntries(entries);
  const branch = entries.slice(1) as SessionEntry[];
  const row = await sessionMetadata(path);
  return {
    sessionId: header.id,
    cwd: header.cwd,
    name: row?.name || `Session ${header.id.slice(0, 8)}`,
    updatedAt: row?.updatedAt || Date.now(),
    transcript: {
      ...emptyProjection(),
      items: activeHistory(branch, branch.at(-1)?.id ?? null),
    },
  };
}

export async function listHistory(
  root = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'),
    'sessions',
  ),
): Promise<HistoryRow[]> {
  const files: string[] = [];
  try {
    for (const directory of await readdir(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of await readdir(join(root, directory.name)))
        if (file.endsWith('.jsonl'))
          files.push(join(root, directory.name, file));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result: HistoryRow[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (index < files.length) {
        try {
          const row = await sessionMetadata(files[index++]);
          if (row?.hasMessages) result.push(row);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }),
  );
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
