import { dirname, join, resolve, sep } from 'node:path';
import { CliBridge } from './bridge';
import { canonicalFile } from './ownership';
import type { RpcExtensionUIResponse } from '@earendil-works/pi-coding-agent';
import type {
  TerminalUpdate,
  Image,
  PiCommand,
  PendingSelection,
  PiUpdate,
  Session,
} from '../shared/types';
import { Terminals } from './terminal';
import { mergeMessageDeltas } from '../shared/transcript';
import { PiSessions } from './pi';
import { Store } from './store';
import {
  getGitStatus,
  listFiles,
  revealWorkspacePath,
  trashWorkspacePath,
  getWorkspaceFile,
  saveWorkspaceFile,
  stageGitFiles,
  unstageGitFiles,
  commitGit,
  switchGitBranch,
} from './git';
import { listenLocal, publishRuntime, stateDirectory } from './local-runtime';
import { pickFiles } from './native-files';

type Body = Record<string, unknown>;
function text(body: Body, key: string, empty = false, max = 100_000): string {
  const value = body[key];
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    throw new Error(`Invalid ${key}`);
  return value;
}

export function piCommand(body: Body): PiCommand {
  switch (body.type) {
    case 'prompt': {
      const message = text(body, 'message', true);
      let images: Image[] | undefined;
      if (body.images !== undefined) {
        if (!Array.isArray(body.images) || body.images.length > 4)
          throw new Error('Attach at most 4 images');
        images = body.images.map((image) => {
          if (
            !image ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
              image.mimeType,
            ) ||
            typeof image.data !== 'string' ||
            !image.data.length ||
            image.data.length > 8_000_000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
          )
            throw new Error('Invalid image');
          return { type: 'image', data: image.data, mimeType: image.mimeType };
        });
      }
      if (!message.trim() && !images?.length)
        throw new Error('Message is empty');
      if (
        body.streamingBehavior !== undefined &&
        !['steer', 'followUp'].includes(body.streamingBehavior as string)
      )
        throw new Error('Invalid queue mode');
      return {
        type: 'prompt',
        message,
        images,
        streamingBehavior: body.streamingBehavior as
          'steer' | 'followUp' | undefined,
      };
    }
    case 'get_entries':
      return {
        type: 'get_entries',
        ...(body.since !== undefined
          ? { since: text(body, 'since', false, 200) }
          : {}),
      };
    case 'get_tree':
    case 'get_fork_messages':
      return { type: body.type };
    case 'navigate_tree':
      return {
        type: 'navigate_tree',
        targetId: text(body, 'targetId', false, 200),
      };
    case 'fork': {
      if (
        body.position !== undefined &&
        body.position !== 'before' &&
        body.position !== 'at'
      )
        throw new Error('Invalid fork position');
      return {
        type: 'fork',
        entryId: text(body, 'entryId', false, 200),
        position: body.position as 'before' | 'at' | undefined,
      };
    }
    case 'clear_queue': {
      if (body.from === undefined) return { type: 'clear_queue' };
      if (!body.from || typeof body.from !== 'object' || Array.isArray(body.from))
        throw new Error('Invalid pending selection');

      const from = body.from as Partial<PendingSelection>;
      const { mode, index, queue } = from;
      if (
        (mode !== 'steering' && mode !== 'followUp') ||
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !queue ||
        typeof queue !== 'object' ||
        !Array.isArray(queue.steering) ||
        !Array.isArray(queue.followUp) ||
        !queue.steering.every((value: unknown) => typeof value === 'string') ||
        !queue.followUp.every((value: unknown) => typeof value === 'string') ||
        index >= queue[mode].length
      )
        throw new Error('Invalid pending selection');

      return {
        type: 'clear_queue',
        from: {
          mode,
          index,
          queue: { steering: queue.steering, followUp: queue.followUp },
        },
      };
    }
    case 'abort':
    case 'compact':
      return { type: body.type };
    case 'set_model':
      return {
        type: 'set_model',
        provider: text(body, 'provider'),
        modelId: text(body, 'modelId'),
      };
    case 'set_session_name':
      return { type: 'set_session_name', name: text(body, 'name', false, 200) };
    case 'set_thinking_level': {
      const level = text(body, 'level');
      if (
        !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
          level,
        )
      )
        throw new Error('Invalid thinking level');
      return { type: 'set_thinking_level', level: level as 'off' };
    }
    default:
      throw new Error('Unsupported command');
  }
}

export function stream<T>(
  subscribe: (send: (value: T) => void) => () => void,
  serialize: (value: T) => string = JSON.stringify,
): Response {
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (frame: string) => {
          if (closed) return;
          if (Buffer.byteLength(frame) > 32 * 1024 * 1024) {
            controller.enqueue(
              encoder.encode(
                'event: stream_error\ndata: "Session data exceeds the 32 MiB display limit. Open this history in the CLI."\n\n',
              ),
            );
            closed = true;
            cleanup();
            clearInterval(heartbeat);
            controller.close();
            return;
          }
          // Discard the backlog; slow readers reconnect from an authoritative snapshot.
          if ((controller.desiredSize ?? 0) < 0) {
            closed = true;
            cleanup();
            clearInterval(heartbeat);
            controller.error(new Error('SSE client is not consuming updates'));
            return;
          }
          controller.enqueue(encoder.encode(frame));
        };
        cleanup = subscribe((value) => {
          if (closed) return;
          try {
            write(`data: ${serialize(value)}\n\n`);
          } catch (error) {
            closed = true;
            cleanup();
            clearInterval(heartbeat);
            controller.error(error);
          }
        });
        if (closed) cleanup();
        else heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
      },
      cancel() {
        closed = true;
        cleanup();
        clearInterval(heartbeat);
      },
    },
    { highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Coalesce partial progress without dropping text or crossing event boundaries. */
export function piStream(
  subscribe: (send: (value: PiUpdate) => void) => () => void,
): Response {
  return stream<PiUpdate>((send) => {
    const pending = new Map<string, PiUpdate>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delta: Extract<PiUpdate, { kind: 'event' }> | undefined;
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDelta = () => {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
      delta = undefined;
    };
    const flushDelta = () => {
      const update = delta;
      clearDelta();
      if (!stopped && update) send(update);
    };
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    };
    const flush = () => {
      const updates = [...pending.values()];
      clear();
      for (const update of updates) {
        if (stopped) break;
        send(update);
      }
    };
    const unsubscribe = subscribe((update) => {
      if (stopped) return;
      if (update.kind === 'snapshot') {
        clearDelta();
        clear();
      } else if (update.kind === 'event') {
        const event = update.value;
        let merged = mergeMessageDeltas(delta?.value, event);
        if (!merged) {
          flushDelta();
          merged = mergeMessageDeltas(undefined, event);
        }
        if (merged) {
          delta = { kind: 'event', value: merged };
          deltaTimer ??= setTimeout(flushDelta, 50);
          return;
        }
        if (event.type === 'tool_execution_update') {
          pending.set(event.toolCallId, update);
          timer ??= setTimeout(flush, 150);
          return;
        }
        if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'agent_settled') clear();
        else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
          pending.delete(event.toolCallId);
          if (!pending.size) clear();
        }
      } else flushDelta();
      send(update);
    });
    return () => {
      stopped = true;
      clearDelta();
      clear();
      unsubscribe();
    };
  });
}

export function startServer(
  options: {
    port?: number;
    dataDir?: string;
    cwd?: string;
    agentDir?: string;
    bridgeSocket?: string;
  } = {},
) {
  const publicOrigin = process.env.PI_WEBUI_PUBLIC_ORIGIN;
  const publicURL = publicOrigin ? new URL(publicOrigin) : undefined;
  if (publicURL && (publicURL.protocol !== 'https:' || publicURL.origin !== publicOrigin))
    throw new Error('PI_WEBUI_PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash');
  const dataDir = options.dataDir ?? stateDirectory();
  const bridgeSocket =
    options.bridgeSocket ??
    process.env.PI_WEBUI_SOCKET ??
    join(dataDir, 'bridge.sock');
  const resuming = new Set<string>();
  const pi: PiSessions = new PiSessions(new Store(dataDir), {
    agentDir: options.agentDir,
    ownershipDir: join(dirname(bridgeSocket), 'leases'),
    isOwned: (file) => bridge.owns(file),
  });
  const storedByFile = (file: string) => {
    const path = canonicalFile(file);
    return pi.list().find((session) => session.file && canonicalFile(session.file) === path);
  };
  const bridge: CliBridge = new CliBridge(
    bridgeSocket,
    (file) => resuming.has(canonicalFile(file)) || pi.owns(file),
    async (file) => {
      const row = storedByFile(file);
      if (!row) throw new Error('No shared session owns this file');
      const runtime = await pi.open(row.id);
      await runtime.ready;
      return {
        command: (command) => runtime.command(command),
        respond: (response) => runtime.respond(response),
        subscribe: (listener) => {
          runtime.listeners.add(listener);
          listener({ kind: 'snapshot', value: runtime.snapshot() });
          return () => { runtime.listeners.delete(listener); };
        },
      };
    },
  );
  const catalogListeners = new Set<(serialized: string) => void>();
  pi.onChange = bridge.onChange = () => {
    if (!catalogListeners.size) return;
    const serialized = JSON.stringify(catalog());
    for (const listener of catalogListeners) listener(serialized);
  };
  const catalog = () => {
    const native = bridge.list();
    const web = pi.list();
    const nativeByFile = new Map(native.flatMap((row) =>
      row.file ? [[canonicalFile(row.file), row] as const] : [],
    ));
    const represented = new Set(web.map((row) => row.file && canonicalFile(row.file)));
    return {
      defaultCwd,
      sessions: [
        ...web.map((row) => {
          if (!row.file) return row;
          const file = canonicalFile(row.file);
          const live = nativeByFile.get(file);
          return live && bridge.owns(file) ? { ...live, id: row.id } : row;
        }),
        ...native.filter((row) => !row.file || !represented.has(canonicalFile(row.file))),
      ].sort((a, b) => b.updatedAt - a.updatedAt),
    };
  };
  const runtimeFor = async (id: string) => {
    await bridge.ready;
    const row = pi.list().find((session) => session.id === id);
    const linked = row?.file && bridge.byFile(row.file);
    const native = bridge.get(linked ? linked.id : id);
    if (native) {
      const file = native.state.session.file;
      if (file && pi.owns(file)) {
        const web = storedByFile(file);
        if (web) return pi.open(web.id);
      }
      if (!row || (row.file && bridge.owns(row.file))) return native;
    }
    if (id.startsWith('cli:'))
      throw new Error('CLI is not connected. Run /reload in that pi session.');
    return pi.open(id);
  };
  const terminals = new Terminals();
  const defaultCwd = options.cwd ?? process.env.PI_WEBUI_CWD ?? process.cwd();
  const dist = resolve(import.meta.dir, '../dist');

  const configuredPort = process.env.PI_WEBUI_PORT ?? process.env.PORT;
  const server = listenLocal({
    port:
      options.port ??
      (configuredPort === undefined ? undefined : Number(configuredPort)),
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const allowedHosts = [
        `127.0.0.1:${server.port}`,
        `localhost:${server.port}`,
      ];
      if (publicURL) allowedHosts.push(publicURL.host);
      if (!allowedHosts.includes(request.headers.get('host') ?? ''))
        return new Response('Invalid host', { status: 403 });
      const origin = request.headers.get('origin');
      const allowedOrigins = [
        `http://127.0.0.1:${server.port}`,
        `http://localhost:${server.port}`,
        ...(publicOrigin ? [publicOrigin] : []),
      ];
      if (process.env.PI_WEBUI_DEV === '1')
        allowedOrigins.push('http://127.0.0.1:5173', 'http://localhost:5173');
      const pageNavigation =
        request.method === 'GET' &&
        !url.pathname.startsWith('/api/') &&
        request.headers.get('sec-fetch-mode') === 'navigate' &&
        request.headers.get('sec-fetch-dest') === 'document';
      if (
        (origin && !allowedOrigins.includes(origin)) ||
        (request.headers.get('sec-fetch-site') === 'cross-site' && !pageNavigation)
      )
        return new Response('Cross-origin access denied', { status: 403 });
      try {
        const response = url.pathname.startsWith('/api/')
          ? await api(request, url)
          : await asset(url);
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('X-Frame-Options', 'DENY');
        response.headers.set('Referrer-Policy', 'no-referrer');
        response.headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        return response;
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          {
            status: (error as { status?: number }).status === 409 ? 409 : 400,
            headers: { 'Cache-Control': 'no-store' },
          },
        );
      }
    },
  });

  async function api(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (request.method === 'GET') {
      if (path === '/api/git')
        return Response.json(
          await getGitStatus(text(Object.fromEntries(url.searchParams), 'cwd')),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      if (path === '/api/files') {
        const query = Object.fromEntries(url.searchParams);
        return Response.json(
          await listFiles(text(query, 'cwd'), query.path ?? ''),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (path === '/api/files/file' || path === '/api/git/file') {
        const query = Object.fromEntries(url.searchParams);
        return Response.json(
          await getWorkspaceFile(text(query, 'cwd'), text(query, 'path')),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (path === '/api/health')
        return Response.json({ service: 'pi-webui', pid: process.pid });
      if (path === '/api/bootstrap') return Response.json(catalog());
      if (path === '/api/pi/catalog/stream') {
        await bridge.ready;
        return stream<string>((send) => {
          let previous = '';
          const update = (serialized: string) => {
            if (serialized !== previous) {
              previous = serialized;
              send(serialized);
            }
          };
          catalogListeners.add(update);
          update(JSON.stringify(catalog()));
          return () => catalogListeners.delete(update);
        }, (serialized) => serialized);
      }
      if (path === '/api/pi/history') return Response.json(await pi.history());
      const match = path.match(/^\/api\/pi\/([^/]+)\/stream$/);
      if (match) {
        const runtime = await runtimeFor(decodeURIComponent(match[1]));
        return piStream((send) => {
          if ('subscribe' in runtime) return runtime.subscribe(send);
          runtime.listeners.add(send);
          send({ kind: 'snapshot', value: runtime.snapshot() });
          return () => runtime.listeners.delete(send);
        });
      }
      const terminalStream = path.match(/^\/api\/terminals\/([^/]+)\/stream$/);
      if (terminalStream)
        return stream<TerminalUpdate>((send) =>
          terminals.subscribe(decodeURIComponent(terminalStream[1]), send),
        );
    }
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return new Response('JSON required', { status: 415 });
      const body: Body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('Invalid request');
      if (path === '/api/files/pick')
        return Response.json(await pickFiles(text(body, 'cwd', false, 4096)));
      if (path === '/api/files/file' || path === '/api/git/file')
        return Response.json(
          await saveWorkspaceFile(
            text(body, 'cwd'),
            text(body, 'path'),
            text(body, 'content', true, 1_048_576),
            text(body, 'expectedVersion'),
          ),
        );
      if (path === '/api/files/reveal' || path === '/api/files/delete') {
        const cwd = text(body, 'cwd', false, 4096);
        const target = text(body, 'path', false, 4096);
        if (path === '/api/files/delete') {
          if (body.confirmed !== true) throw new Error('Deletion requires confirmation');
          await trashWorkspacePath(cwd, target);
        } else await revealWorkspacePath(cwd, target);
        return Response.json({ ok: true });
      }
      if (path === '/api/git/stage' || path === '/api/git/unstage') {
        if (
          !Array.isArray(body.paths) ||
          !body.paths.length ||
          body.paths.length > 100 ||
          !body.paths.every(
            (path) =>
              typeof path === 'string' && path.length && path.length <= 4_096,
          )
        )
          throw new Error('Select valid file paths');
        let expectedFiles: { path: string; version: string }[] | undefined;
        if (body.expectedFiles !== undefined) {
          if (
            !Array.isArray(body.expectedFiles) ||
            body.expectedFiles.length > 100
          )
            throw new Error('Invalid file versions');
          expectedFiles = body.expectedFiles.map((file) => ({
            path: text(file, 'path', false, 4_096),
            version: text(file, 'version', false, 200),
          }));
        }
        return Response.json(
          await (path === '/api/git/unstage'
            ? unstageGitFiles(
                text(body, 'cwd'),
                body.paths,
                text(body, 'expectedIndexVersion'),
              )
            : stageGitFiles(
                text(body, 'cwd'),
                body.paths,
                text(body, 'expectedIndexVersion'),
                expectedFiles,
              )),
        );
      }
      if (path === '/api/git/switch' || path === '/api/git/create-branch')
        return Response.json(
          await switchGitBranch(
            text(body, 'cwd'),
            text(body, 'branch', false, 1_024),
            text(body, 'expectedIndexVersion'),
            path === '/api/git/create-branch',
          ),
        );
      if (path === '/api/git/commit')
        return Response.json(
          await commitGit(
            text(body, 'cwd'),
            text(body, 'message', false, 10_000),
            text(body, 'expectedIndexVersion'),
          ),
        );
      if (path === '/api/pi/rename' || path === '/api/pi/delete') {
        await bridge.ready;
        const file = await pi.sessionFile(text(body, 'path'));
        if (path === '/api/pi/rename') {
          const name = text(body, 'name', false, 200).trim();
          if (!name) throw new Error('Session name is required');
          if (bridge.owns(file)) {
            const row = bridge.byFile(file);
            if (!row?.connected) throw new Error('Reconnect the CLI before renaming this session');
            await (await runtimeFor(row.id)).command({ type: 'set_session_name', name });
          } else {
            await pi.rename(file, name);
            if (!bridge.byFile(file)?.connected) bridge.forget(file);
          }
        } else {
          if (body.confirmed !== true) throw new Error('Confirm session deletion first');
          if (bridge.owns(file)) throw new Error('Close the CLI before deleting this session');
          await pi.remove(file);
          bridge.forget(file);
        }
        return Response.json({ ok: true });
      }
      if (path === '/api/pi/attach') {
        await bridge.ready;
        const file = canonicalFile(text(body, 'path'));
        const native = bridge.byFile(file);
        const owned = storedByFile(file);
        return Response.json(
          bridge.owns(file)
            ? native ? { ...native, id: owned?.id ?? native.id } : await bridge.watch(file)
            : owned ?? await pi.resume(file),
        );
      }
      if (path === '/api/pi/resume') {
        await bridge.ready;
        if (body.cliClosed !== true)
          throw new Error(
            'Confirm that the CLI session is closed before resuming',
          );
        const file = canonicalFile(text(body, 'path'));
        const native = bridge.byFile(file);
        if (native?.connected)
          return Response.json({ ...native, id: storedByFile(file)?.id ?? native.id });
        if (resuming.has(file))
          throw new Error('Session is already being resumed');
        resuming.add(file);
        try {
          return Response.json(await pi.resume(file));
        } finally {
          resuming.delete(file);
        }
      }
      if (path === '/api/pi/sessions')
        return Response.json(
          await pi.create(
            text(body, 'cwd'),
            body.source === undefined ? undefined : text(body, 'source'),
          ),
        );
      const match = path.match(
        /^\/api\/pi\/([^/]+)\/(command|respond|restart)$/,
      );
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (match[2] === 'restart') {
          const native = bridge.get(id);
          if (!native && !id.startsWith('cli:')) await pi.restart(id);
          else if (!native?.state.connected)
            throw new Error('Run /reload in the CLI to reconnect it.');
          return Response.json({ ok: true });
        }
        const runtime = await runtimeFor(id);
        if (match[2] === 'command') {
          const command = piCommand(body);
          const result = await runtime.command(command);
          const forked = (result as { session?: Session } | null)?.session;
          if (command.type === 'fork' && forked?.kind === 'cli') {
            const deadline = Date.now() + 5_000;
            while (!bridge.get(forked.id) && Date.now() < deadline)
              await Bun.sleep(20);
            const native = bridge.get(forked.id);
            if (native) await Promise.race([native.ready, Bun.sleep(5_000)]);
          }
          return Response.json(result);
        }
        const response: RpcExtensionUIResponse = {
          type: 'extension_ui_response',
          id: text(body, 'id'),
          ...(body.cancelled === true
            ? { cancelled: true }
            : typeof body.confirmed === 'boolean'
              ? { confirmed: body.confirmed }
              : { value: text(body, 'value', true) }),
        };
        await runtime.respond(response);
        return Response.json({ ok: true });
      }
      if (path === '/api/terminals')
        return Response.json(terminals.create(text(body, 'cwd')));
      const terminalAction = path.match(/^\/api\/terminals\/([^/]+)\/(input|resize|close)$/);
      if (terminalAction) {
        const id = decodeURIComponent(terminalAction[1]);
        switch (terminalAction[2]) {
          case 'input':
            terminals.input(id, text(body, 'text', true));
            break;
          case 'resize':
            terminals.resize(id, body.cols as number, body.rows as number);
            break;
          case 'close':
            await terminals.close(id);
            break;
        }
        return Response.json({ ok: true });
      }
    }
    return new Response('Not found', { status: 404 });
  }

  async function asset(url: URL) {
    const path = resolve(
      dist,
      `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
    );
    if (
      path !== join(dist, 'index.html') &&
      !path.startsWith(join(dist, 'assets') + sep)
    )
      return new Response('Not found', { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists()))
      return new Response(
        url.pathname === '/' ? 'Run bun run build first.' : 'Not found',
        { status: 404 },
      );
    return new Response(file, {
      headers: {
        'Cache-Control': url.pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    });
  }

  return {
    server,
    pi,
    bridge,
    terminals,
    ready: bridge.ready,
    async stop() {
      await server.stop(true);
      await bridge.stop();
      await terminals.stop();
      await pi.stop();
    },
  };
}

export async function runServer() {
  // This process hosts agents; inherited terminal identity must not leak into their tools.
  for (const key of Object.keys(process.env))
    if (
      [
        'PI_SESSION_ID',
        'PI_SESSION_FILE',
        'PI_PROVIDER',
        'PI_MODEL',
        'PI_REASONING_LEVEL',
      ].includes(key)
    )
      delete process.env[key];
  const app = startServer();
  await app.ready;
  const url = `http://127.0.0.1:${app.server.port}`;
  const unpublish = publishRuntime(url);
  console.log(`pi-webui · ${url}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    unpublish();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) await runServer();
