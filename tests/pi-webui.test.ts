import { expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { claimSessionFile } from '../server/ownership';
import { JsonlConnection } from '../server/jsonl';
import piWebUI from '../extensions/pi-webui';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkBridgeIsolation() {
  const previousSocket = process.env.PI_WEBUI_SOCKET;
  try {
    for (const fault of ['offline', 'web-owner', 'cli-owner', 'late-owner', 'invalid-lease', 'lost-lease', 'startup-error', 'hello-error', 'bridge-error', 'invalid-json', 'disconnect']) {
      const root = mkdtempSync('/tmp/pi-webui-');
      const file = join(root, 'session.jsonl');
      const socketPath = join(root, 'bridge.sock');
      const leases = join(root, 'leases');
      process.env.PI_WEBUI_SOCKET = socketPath;
      writeFileSync(file, '');
      let sessionFile: string | undefined = fault === 'late-owner' ? undefined : file;
      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
      const abort = mock(() => {});
      const custom = mock(() => Promise.resolve());
      const shutdown = mock(() => {});
      const notify = mock(() => {});
      const ctx = {
        mode: 'tui', isIdle: () => false, abort, shutdown,
        ui: { custom, notify },
        getContextUsage: () => undefined,
        modelRegistry: { getAvailable: () => {
          if (fault === 'startup-error') throw new Error('Model registry unavailable');
          return [];
        } },
        sessionManager: {
          getSessionId: () => 'native-session', getSessionFile: () => sessionFile,
          getEntries: () => [], getLeafId: () => null,
          getCwd: () => root, getSessionName: () => undefined,
        },
      } as unknown as ExtensionContext;
      const pi = {
        on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        registerCommand: () => {}, getThinkingLevel: () => 'off',
        getSessionName: () => undefined, getCommands: () => [],
      } as unknown as ExtensionAPI;
      const emit = async (type: string, event: object = {}) => {
        const results = [];
        for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
        return results;
      };
      const sockets = new Set<Socket>();
      let snapshotReceived = false;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const rpc = new JsonlConnection(socket, socket);
        rpc.onEvent = (record: any) => {
          if (record.type === 'hello') {
            if (fault === 'invalid-json') { socket.write('invalid json\n'); return; }
            void rpc.write(fault === 'hello-error'
              ? { id: record.id, type: 'response', success: false, error: 'Session already owned by Web' }
              : { id: record.id, type: 'response', success: true, data: { connectionId: 'test' } });
          } else if (record.type === 'snapshot') {
            snapshotReceived = true;
            if (fault === 'bridge-error') void rpc.write({ type: 'bridge_error', error: 'Session file already owned' });
            if (fault === 'disconnect') socket.destroy();
          }
        };
      });
      let otherClaim: ReturnType<typeof claimSessionFile> | undefined;
      try {
        if (['web-owner', 'cli-owner', 'late-owner', 'invalid-lease'].includes(fault)) {
          otherClaim = claimSessionFile(file, leases, fault === 'cli-owner' ? 'cli' : 'web');
          if (fault === 'invalid-lease') writeFileSync(join(leases, readdirSync(leases)[0]), '{');
        }
        if (['hello-error', 'bridge-error', 'invalid-json', 'disconnect'].includes(fault))
          await new Promise<void>((resolve) => server.listen(socketPath, resolve));
        piWebUI(pi);
        await emit('session_start', { reason: 'startup' });
        if (server.listening) {
          for (let i = 0; i < 100 && !snapshotReceived && !notify.mock.calls.length; i++) await sleep(10);
          if (['bridge-error', 'disconnect'].includes(fault)) expect(snapshotReceived).toBe(true);
        }
        await sleep(30);
        if (fault === 'late-owner') sessionFile = file;
        if (fault === 'lost-lease') {
          const path = join(leases, readdirSync(leases)[0]);
          writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), token: 'another-owner' }));
        }
        await emit('agent_start');
        await emit('message_start', { message: { role: 'user', content: 'Continue in CLI', timestamp: Date.now() } });
        for (const type of ['input', 'session_before_fork', 'session_before_compact', 'session_before_tree'])
          expect(await emit(type, { text: 'Continue in CLI' })).toEqual([]);
        expect(abort).not.toHaveBeenCalled();
        expect(custom).not.toHaveBeenCalled();
        expect(shutdown).not.toHaveBeenCalled();
        if (['web-owner', 'cli-owner', 'late-owner', 'invalid-lease', 'lost-lease', 'startup-error', 'hello-error', 'bridge-error'].includes(fault))
          expect(notify).toHaveBeenCalled();
      } finally {
        await emit('session_shutdown', { reason: 'quit' });
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (fault !== 'invalid-lease') otherClaim?.release();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousSocket === undefined) delete process.env.PI_WEBUI_SOCKET;
    else process.env.PI_WEBUI_SOCKET = previousSocket;
  }
}

if (process.argv.includes('--bridge-check')) {
  await checkBridgeIsolation();
} else {
  test('bridge failures never take over, abort, or block the native CLI', async () => {
    // Bun's test runner fails on handled socket connection errors; exercise them in a subprocess.
    const child = Bun.spawn([process.execPath, import.meta.filename, '--bridge-check'], { stdout: 'ignore', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  });
}
