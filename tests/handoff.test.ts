import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index';
import { canonicalFile, claimSessionFile } from '../server/ownership';
import type { Session } from '../shared/types';

test('attaching preserves a live CLI and resumes its history after it closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-webui-handoff-'));
  const agentDir = join(root, 'agent');
  const folder = join(agentDir, 'sessions', 'workspace');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], noSkills: true }));
  const file = join(folder, 'session.jsonl');
  writeFileSync(file, [
    { type: 'session', version: 3, id: 'handoff-session', timestamp: new Date().toISOString(), cwd: root },
    { type: 'message', id: 'user', parentId: null, timestamp: new Date().toISOString(), message: {
      role: 'user', content: [{ type: 'text', text: 'Saved CLI message' }], timestamp: Date.now(),
    } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const claim = claimSessionFile(file, join(root, 'leases'), 'cli');
  const app = startServer({ port: 0, dataDir: root, agentDir, bridgeSocket: join(root, 'bridge.sock'), cwd: root });
  const attach = async () => {
    const response = await fetch(`http://127.0.0.1:${app.server.port}/api/pi/attach`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<Session>;
  };
  try {
    await app.ready;
    expect((await attach()).kind).toBe('cli');
    expect(app.pi.list()).toHaveLength(0);
    claim.release();
    const resumed = await attach();
    expect(resumed.kind).toBe('web');
    expect(resumed.file).toBe(canonicalFile(file));
    expect((await attach()).id).toBe(resumed.id);
    const runtime = await app.pi.open(resumed.id);
    await runtime.ready;
    expect(runtime.state.error).toBeUndefined();
    expect(runtime.state.connected).toBe(true);
    expect(runtime.transcript.items[0]?.message).toMatchObject({
      role: 'user', content: [{ type: 'text', text: 'Saved CLI message' }],
    });
  } finally {
    claim.release();
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
