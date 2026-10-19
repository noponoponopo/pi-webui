import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contentText } from '@earendil-works/pi-ai';
import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  applyEvent,
  activeHistory,
  messageText,
  emptyProjection,
} from '../shared/transcript';
import type {
  PiCommand,
  PiEvent,
  PiSnapshot,
  PiState,
  PiUpdate,
  Projection,
  Session,
} from '../shared/types';
import {
  claimSessionFile,
  canonicalFile,
  type SessionClaim,
} from '../server/ownership';
import { sessionEntries, sessionStats, toPiEvent } from '../server/session-events';
import {
  JsonlConnection,
  guardJsonlFrames,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
} from '../server/jsonl';
import { stateDirectory } from '../server/local-runtime';
const NAVIGATE_COMMAND = 'pi-webui-control';
const QUEUE_RECOVERY_REASON = 'Installed Pi does not expose native queue read/clear actions to extensions. Alt-Up in the terminal can recover the queue without aborting.';
const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type NativePeer = {
  socket: Socket;
  rpc: JsonlConnection;
  connectionId: string;
};

type QueuedRecord = { line: string; bytes: number };

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicModel(model: {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}) {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  };
}

function expandHome(path: string): string {
  return path === '~'
    ? homedir()
    : path.startsWith('~/')
      ? join(homedir(), path.slice(2))
      : path;
}

function socketAddress(): string {
  if (process.env.PI_WEBUI_SOCKET)
    return resolve(expandHome(process.env.PI_WEBUI_SOCKET));
  return join(resolve(expandHome(stateDirectory())), 'bridge.sock');
}

function ownershipDirectory(path: string): string {
  return join(dirname(path), 'leases');
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

class NativeBridgeSession {
  private stopped = false;
  private sequence = 0;
  private connection?: NativePeer;
  private claim?: SessionClaim;
  private claimPath?: string;
  private projection: Projection;
  private state: PiState;
  private promptActive = false;
  private phase: 'offline' | 'snapshot' | 'live' = 'offline';
  private queued: QueuedRecord[] = [];
  private queuedBytes = 0;
  private flushPromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private wakeRetry?: () => void;
  private snapshotWarningShown = false;
  private forkReplyId?: string;
  private replacing = false;
  private navigation?: {
    token: string;
    targetId: string;
    action: 'navigate_tree' | 'fork';
    position?: 'before' | 'at';
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  readonly socketPath = socketAddress();
  private readonly leaseRoot = ownershipDirectory(this.socketPath);

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) {
    this.projection = {
      ...emptyProjection(),
      items: activeHistory(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ),
      running: !ctx.isIdle(),
    };
    this.state = this.readState(false);
  }

  start(): void {
    void this.reconnect();
  }

  matches(ctx: ExtensionContext): boolean {
    return (
      !this.stopped &&
      ctx.mode === 'tui' &&
      ctx.sessionManager.getSessionId() ===
        this.ctx.sessionManager.getSessionId()
    );
  }

  private readState(connected: boolean): PiState {
    const firstUser = this.projection.items.find(
      (item) => item.message.role === 'user',
    )?.message;
    const promptName = firstUser
      ? messageText(firstUser).trim().split('\n')[0].slice(0, 80)
      : '';
    const current = this.ctx.model;
    const models = this.ctx.modelRegistry.getAvailable().map(publicModel);
    const contextUsage = this.ctx.getContextUsage();
    const thinkingLevel = this.ctx.thinkingLevel ?? this.pi.getThinkingLevel();
    const levels = current?.reasoning ? [...THINKING_LEVELS] : ['off'];
    if (!levels.includes(thinkingLevel)) levels.push(thinkingLevel);
    const file = this.ctx.sessionManager.getSessionFile();
    const updatedAt = this.ctx.sessionManager.getEntries().reduce(
      (latest, entry) => Math.max(latest, Date.parse(entry.timestamp) || 0),
      this.state?.session.updatedAt ?? 0,
    ) || Date.now();
    return {
      owner: 'cli',
      connected,
      session: {
        kind: 'cli',
        id: `cli:${this.ctx.sessionManager.getSessionId()}`,
        cwd: this.ctx.sessionManager.getCwd(),
        name:
          this.ctx.sessionManager.getSessionName() ||
          this.pi.getSessionName() ||
          promptName ||
          `CLI ${this.ctx.sessionManager.getSessionId().slice(0, 8)}`,
        updatedAt,
        ...(file ? { file } : {}),
      },
      loading: false,
      ...(current ? { model: publicModel(current) } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      stats: sessionStats(this.ctx.sessionManager, contextUsage),
      models,
      thinkingLevel,
      levels,
      commands: this.pi
        .getCommands()
        .map(({ name, description }) => ({ name, description })),
      dialogs: [],
      statuses: {},
      leafId: this.ctx.sessionManager.getLeafId(),
      capabilities: {
        queueRecovery: false,
        queueRecoveryReason: QUEUE_RECOVERY_REASON,
        treeNavigation: true,
      },
      ...(this.promptActive
        ? { notice: 'Answer this prompt in the terminal.' }
        : {}),
    };
  }

  private ensureClaim(): boolean {
    if (this.stopped) return false;
    const file = this.ctx.sessionManager.getSessionFile();
    if (!file) return true;
    try {
      const key = canonicalFile(file);
      if (this.claim) {
        if (this.claimPath !== key)
          throw new Error(
            'Native Pi changed session files without shutting down the old session',
          );
        this.claim.assertOwner();
        return true;
      }
      this.claim = claimSessionFile(key, this.leaseRoot, 'cli');
      this.claimPath = this.claim.file;
      this.state = {
        ...this.state,
        session: { ...this.state.session, file: this.claim.file },
      };
      this.send({ kind: 'state', value: this.state });
      return true;
    } catch (error) {
      this.ownershipConflict(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  private ownershipConflict(message: string): void {
    if (this.stopped) return;
    this.ctx.ui.notify(
      `Pi Web UI sync disabled: ${message}. CLI remains active.`,
      'warning',
    );
    void this.stop('quit');
  }

  private async reconnect(): Promise<void> {
    let backoff = 250;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = 250;
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        if (
          /already owned|already live|ownership|session file changed/i.test(
            message,
          )
        ) {
          this.ownershipConflict(message);
          return;
        }
        if (
          /snapshot exceeds the 32 MiB/i.test(message) &&
          !this.snapshotWarningShown
        ) {
          this.snapshotWarningShown = true;
          this.ctx.ui.notify(
            `Pi Web UI bridge cannot send this session: ${message}`,
            'warning',
          );
        }
      }
      if (this.stopped) return;
      await new Promise<void>((done) => {
        this.wakeRetry = done;
        this.retryTimer = setTimeout(done, backoff);
      });
      this.retryTimer = undefined;
      this.wakeRetry = undefined;
      backoff = Math.min(backoff * 2, 5000);
    }
  }

  private async connectOnce(): Promise<void> {
    if (!this.ensureClaim()) return;
    const socket = createConnection(this.socketPath);
    socket.setNoDelay(true);
    const output = guardJsonlFrames(socket);
    const rpc = new JsonlConnection(socket, output);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => (resolveClosed = done));
    let peer: NativePeer | undefined;
    rpc.onClose = () => {
      if (this.connection?.rpc === rpc) {
        this.connection = undefined;
        this.phase = 'offline';
        this.queued = [];
        this.queuedBytes = 0;
      }
      resolveClosed();
    };
    rpc.onEvent = (record) => {
      const peer = this.connection;
      if (peer?.rpc === rpc) this.handleRecord(record, peer);
    };

    try {
      await new Promise<void>((resolveConnect, rejectConnect) => {
        const timer = setTimeout(() => {
          socket.destroy();
          rejectConnect(new Error('Bridge connect timed out'));
        }, 2500);
        const onError = (error: Error) => {
          clearTimeout(timer);
          rejectConnect(error);
        };
        socket.once('error', onError);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.off('error', onError);
          resolveConnect();
        });
      });
      const response = await rpc.request<{ connectionId: string }>(
        {
          type: 'hello',
          sessionId: this.ctx.sessionManager.getSessionId(),
          pid: process.pid,
          file: this.claim?.file ?? this.ctx.sessionManager.getSessionFile(),
          cwd: this.ctx.sessionManager.getCwd(),
          name: this.state.session.name,
        },
        2500,
      );
      if (this.stopped) return;
      if (!response?.connectionId)
        throw new Error('Bridge returned no connection ID');
      peer = { socket, rpc, connectionId: response.connectionId };
      this.connection = peer;
      this.phase = 'snapshot';
      const snapshot = this.canonicalSnapshot(true);
      const record = {
        type: 'snapshot',
        connectionId: peer.connectionId,
        sequence: this.sequence,
        value: snapshot,
      };
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_FRAME_BYTES)
        throw new Error(
          'Native session snapshot exceeds the 32 MiB frame limit',
        );
      await rpc.write(record);
      if (this.connection !== peer) return;
      this.phase = 'live';
      void this.flush();
      await closed;
    } finally {
      if (this.connection?.rpc === rpc) {
        this.connection = undefined;
        this.phase = 'offline';
        this.queued = [];
        this.queuedBytes = 0;
      }
      rpc.close();
      socket.destroy();
    }
  }

  private handleRecord(record: unknown, peer: NativePeer): void {
    if (this.stopped || !isObject(record) || this.connection !== peer) return;
    if (record.type === 'snapshot_request' && typeof record.id === 'string') {
      void this.sendSnapshotResponse(record.id, peer).catch((error) =>
        this.respond(
          peer,
          record.id,
          false,
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }
    if (record.type === 'bridge_error') {
      const message = String(
        record.error || 'Pi Web UI bridge rejected the native session',
      );
      this.ctx.ui.notify(message, 'error');
      if (/owned|already live|session file/i.test(message))
        this.ownershipConflict(message);
      return;
    }
    if (record.type !== 'command' || typeof record.id !== 'string') return;
    if (record.command?.type === 'fork') this.forkReplyId = record.id;
    void this.command(record.command as PiCommand, peer).then(
      (data) => this.respond(peer, record.id, true, data),
      (error) =>
        this.respond(
          peer,
          record.id,
          false,
          error instanceof Error ? error.message : String(error),
        ),
    );
  }

  private respond(
    peer: NativePeer,
    id: string,
    success: boolean,
    data: unknown,
  ): void {
    if (this.connection !== peer) return;
    void peer.rpc.write(
      success
        ? { id, type: 'response', success: true, data }
        : { id, type: 'response', success: false, error: data },
    ).finally(() => {
      if (this.stopped && id === this.forkReplyId) {
        peer.rpc.close();
        peer.socket.destroy();
        if (this.connection === peer) this.connection = undefined;
      }
    }).catch(() => {});
  }

  private async command(
    command: PiCommand,
    peer: NativePeer,
  ): Promise<unknown> {
    if (this.stopped || this.connection !== peer)
      throw new Error('Native bridge connection changed; retry the command');
    if (!this.ensureClaim())
      throw new Error('Native session ownership was lost');
    if (!isObject(command) || typeof command.type !== 'string')
      throw new Error('Invalid native CLI command');
    switch (command.type) {
      case 'get_entries':
        return sessionEntries(this.ctx.sessionManager, command.since);
      case 'get_tree':
        return { tree: this.ctx.sessionManager.getTree(), leafId: this.ctx.sessionManager.getLeafId() };
      case 'navigate_tree':
        return this.requestNavigation(command.targetId, 'navigate_tree');
      case 'fork':
        return this.requestNavigation(command.entryId, 'fork', command.position);
      case 'prompt':
      case 'steer':
      case 'follow_up': {
        if (typeof command.message !== 'string')
          throw new Error('Message is required');
        if (!this.ctx.isIdle() && !this.projection.running)
          throw new Error(
            'CLI is busy compacting or retrying; submit this message when it is ready.',
          );
        const content = command.images?.length
          ? [
              { type: 'text' as const, text: command.message },
              ...command.images,
            ]
          : command.message;
        const deliverAs =
          command.type === 'steer'
            ? 'steer'
            : command.type === 'follow_up'
              ? 'followUp'
              : command.streamingBehavior === 'steer'
                ? 'steer'
                : command.streamingBehavior === 'followUp'
                  ? 'followUp'
                  : undefined;
        this.pi.sendUserMessage(content, { deliverAs });
        return { disposition: 'submitted' };
      }
      case 'abort':
        this.ctx.abort();
        return { disposition: 'submitted' };
      case 'set_model': {
        const model = this.ctx.modelRegistry.find(
          command.provider,
          command.modelId,
        );
        if (!model)
          throw new Error(
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        const selected = await this.pi.setModel(model);
        if (!selected)
          throw new Error(
            `Could not select ${command.provider}/${command.modelId}; check that its provider credentials are configured.`,
          );
        this.refreshState();
        return { disposition: 'submitted' };
      }
      case 'set_thinking_level':
        this.pi.setThinkingLevel(command.level);
        this.refreshState();
        return { disposition: 'submitted' };
      case 'set_session_name':
        this.pi.setSessionName(command.name);
        this.refreshState();
        return { disposition: 'submitted' };
      case 'compact':
        this.ctx.compact({ customInstructions: command.customInstructions });
        return { disposition: 'submitted' };
      case 'clear_queue':
        throw new Error(QUEUE_RECOVERY_REASON);
      default:
        throw new Error(`Unsupported native CLI command: ${command.type}`);
    }
  }

  private requestNavigation(targetId: string, action: 'navigate_tree' | 'fork', position?: 'before' | 'at'): Promise<unknown> {
    if (!this.ctx.sessionManager.getEntry(targetId)) throw new Error(`Entry ${targetId} not found`);
    if (this.navigation) throw new Error('A branch navigation is already pending');
    return new Promise((resolve, reject) => {
      const token = randomUUID();
      const timer = setTimeout(() => {
        this.navigation = undefined;
        reject(new Error('Native branch command timed out; refresh before retrying'));
      }, 30_000);
      this.navigation = { token, targetId, action, position, resolve, reject, timer };
      this.pi.sendUserMessage(`/${NAVIGATE_COMMAND} ${token}`, { expandPromptTemplates: true });
    });
  }

  async navigate(token: string, ctx: ExtensionCommandContext): Promise<void> {
    const pending = this.navigation;
    if (!pending || pending.token !== token || !this.matches(ctx)) return;
    try {
      if (pending.action === 'navigate_tree' && pending.targetId === ctx.sessionManager.getLeafId()) {
        pending.resolve({ cancelled: false, leafId: pending.targetId });
        return;
      }
      if (pending.action === 'navigate_tree' && !ctx.isIdle()) {
        ctx.abort();
        await ctx.waitForIdle();
      }
      const entry = ctx.sessionManager.getEntry(pending.targetId);
      const shouldPrefill = pending.action === 'fork'
        ? pending.position !== 'at'
        : pending.targetId !== ctx.sessionManager.getLeafId();
      const editorText = !shouldPrefill
        ? undefined
        : entry?.type === 'message' && entry.message.role === 'user'
        ? contentText(entry.message.content, '')
        : entry?.type === 'custom_message'
          ? contentText(entry.content, '')
          : undefined;
      if (pending.action === 'fork') {
        this.replacing = true;
        const source = this.state.session.file;
        let session: Session | undefined;
        const result = await ctx.fork(pending.targetId, {
          position: pending.position,
          withSession: async (fresh) => {
            const manager = fresh.sessionManager;
            session = {
              kind: 'cli',
              id: `cli:${manager.getSessionId()}`,
              cwd: manager.getCwd(),
              name: manager.getSessionName() ?? this.state.session.name,
              updatedAt: Date.now(),
              file: manager.getSessionFile(),
              source,
            };
          },
        });
        pending.resolve({ ...result, session, text: result.cancelled ? undefined : editorText, editorText: result.cancelled ? undefined : editorText });
      } else {
        const result = await ctx.navigateTree(pending.targetId, { summarize: false });
        this.refreshCanonicalSnapshot(false);
        pending.resolve({ ...result, editorText: result.cancelled ? undefined : editorText, leafId: ctx.sessionManager.getLeafId() });
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(pending.timer);
      this.replacing = false;
      if (this.navigation === pending) this.navigation = undefined;
    }
  }

  refreshState(): void {
    if (this.stopped) return;
    this.state = this.readState(Boolean(this.connection));
    this.send({ kind: 'state', value: this.state });
  }

  modelSelected(model: Parameters<typeof publicModel>[0]): void {
    if (this.stopped) return;
    this.state = this.readState(Boolean(this.connection));
    const levels = model.reasoning ? [...THINKING_LEVELS] : ['off'];
    if (!levels.includes(this.state.thinkingLevel))
      levels.push(this.state.thinkingLevel);
    this.state = { ...this.state, model: publicModel(model), levels };
    this.send({ kind: 'state', value: this.state });
  }

  thinkingLevelSelected(level: PiState['thinkingLevel']): void {
    if (this.stopped) return;
    this.state = this.readState(Boolean(this.connection));
    if (!this.state.levels.includes(level))
      this.state = { ...this.state, levels: [...this.state.levels, level] };
    this.state = { ...this.state, thinkingLevel: level };
    this.send({ kind: 'state', value: this.state });
  }

  agentEvent(event: AgentSessionEvent): void {
    if (this.stopped) return;
    if (
      (event.type === 'agent_start' || event.type === 'message_start') &&
      !this.ensureClaim()
    )
      return;
    const value = toPiEvent(event);
    if (!value) return;
    const update = value as PiEvent;
    this.projection = applyEvent(this.projection, update);
    this.sequence++;
    this.enqueue({ kind: 'event', value: update });
    if (event.type === 'session_info_changed') {
      this.state = {
        ...this.state,
        session: {
          ...this.state.session,
          name: event.name || 'CLI session',
          updatedAt: Date.now(),
        },
      };
      this.send({ kind: 'state', value: this.state });
    } else if (event.type === 'message_end') {
      this.state = {
        ...this.state,
        session: { ...this.state.session, updatedAt: Date.now() },
      };
      this.send({ kind: 'state', value: this.state });
    } else if (event.type === 'agent_settled') {
      this.refreshState();
    }
  }

  promptStart(): void {
    this.promptActive = true;
    this.state = {
      ...this.state,
      notice: 'Answer this prompt in the terminal.',
    };
    this.send({ kind: 'state', value: this.state });
  }

  promptEnd(): void {
    this.promptActive = false;
    const { notice: _notice, ...state } = this.state;
    this.state = state;
    this.send({ kind: 'state', value: this.state });
  }

  refreshCanonicalSnapshot(preserveLive: boolean): void {
    if (this.stopped) return;
    const peer = this.connection;
    const snapshot = this.canonicalSnapshot(preserveLive);
    if (!peer || this.phase === 'offline') return;
    this.sequence++;
    this.enqueueRecord({
      type: 'snapshot',
      connectionId: peer.connectionId,
      sequence: this.sequence,
      value: snapshot,
    });
  }

  private canonicalSnapshot(preserveLive: boolean): PiSnapshot {
    const live = this.projection;
    const transcript = emptyProjection();
    transcript.items = activeHistory(
      this.ctx.sessionManager.getEntries(),
      this.ctx.sessionManager.getLeafId(),
    );
    transcript.running = !this.ctx.isIdle();
    if (preserveLive) {
      transcript.partial = live.partial;
      transcript.tools = live.tools;
      transcript.queue = live.queue;
      transcript.activity = live.activity;
    }
    this.projection = transcript;
    this.state = this.readState(Boolean(this.connection));
    return {
      state: {
        ...this.state,
        owner: 'cli',
        connected: Boolean(this.connection),
      },
      transcript,
    };
  }

  private async sendSnapshotResponse(
    id: string,
    peer: NativePeer,
  ): Promise<void> {
    if (this.connection !== peer) return;
    this.phase = 'snapshot';
    try {
      const snapshot = this.canonicalSnapshot(true);
      const response = {
        type: 'snapshot',
        connectionId: peer.connectionId,
        sequence: ++this.sequence,
        value: snapshot,
      };
      if (Buffer.byteLength(JSON.stringify(response)) > MAX_FRAME_BYTES)
        throw new Error(
          'Native session snapshot exceeds the 32 MiB frame limit',
        );
      await peer.rpc.write(response);
      await peer.rpc.write({ id, type: 'response', success: true });
    } finally {
      if (this.connection === peer) {
        await this.flushPromise?.catch(() => {});
        if (this.connection === peer) {
          this.phase = 'live';
          void this.flush();
        }
      }
    }
  }

  private send(update: PiUpdate): void {
    this.sequence++;
    this.enqueue(update);
  }

  private enqueue(value: PiUpdate): void {
    const peer = this.connection;
    if (!peer || this.phase === 'offline') return;
    this.enqueueRecord({
      type: 'update',
      connectionId: peer.connectionId,
      sequence: this.sequence,
      value,
    });
  }

  private enqueueRecord(record: object): void {
    const peer = this.connection;
    if (!peer || this.phase === 'offline') return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (
      bytes > MAX_FRAME_BYTES ||
      this.queuedBytes + bytes > MAX_BUFFERED_BYTES
    ) {
      peer.socket.destroy(new Error('Native bridge backlog exceeded 4 MiB'));
      return;
    }
    this.queued.push({ line, bytes });
    this.queuedBytes += bytes;
    if (this.phase === 'live') void this.flush();
  }

  private flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.phase !== 'live') return Promise.resolve();
    if (!this.queued.length) return Promise.resolve();
    this.flushPromise = this.drainQueue();
    return this.flushPromise;
  }

  private async drainQueue(): Promise<void> {
    try {
      while (this.queued.length && this.connection && this.phase === 'live') {
        const peer = this.connection;
        const next = this.queued.shift()!;
        try {
          await new Promise<void>((done, fail) => {
            peer.socket.write(next.line, (error) =>
              error ? fail(error) : done(),
            );
          });
        } finally {
          this.queuedBytes -= next.bytes;
        }
      }
    } catch {
      this.connection?.socket.destroy();
    } finally {
      this.flushPromise = undefined;
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const holdReply = reason === 'fork' && this.replacing;
    if (this.navigation && !holdReply) {
      clearTimeout(this.navigation.timer);
      this.navigation.reject(new Error('Native session closed during branch navigation'));
      this.navigation = undefined;
    }
    clearTimeout(this.retryTimer);
    this.wakeRetry?.();
    const peer = this.connection;
    if (peer) {
      const flush = this.flush();
      await Promise.race([flush, delay(350)]);
      this.phase = 'offline';
      this.queued = [];
      this.queuedBytes = 0;
      await Promise.race([
        peer.rpc.write({
          type: 'release',
          connectionId: peer.connectionId,
          reason,
        }),
        delay(250),
      ]).catch(() => {});
      if (!holdReply) {
        peer.rpc.close();
        peer.socket.destroy();
        this.connection = undefined;
      }
    }
    this.queued = [];
    this.queuedBytes = 0;
    try {
      this.claim?.release();
    } catch (error) {
      this.ctx.ui.notify(`Pi Web UI lease cleanup failed: ${String(error)}`, 'warning');
    } finally {
      this.claim = undefined;
    }
  }
}

export default function piWebUI(pi: ExtensionAPI): void {
  let active: NativeBridgeSession | undefined;
  const forward = (event: unknown, ctx: ExtensionContext) => {
    if (active?.matches(ctx)) active.agentEvent(event as AgentSessionEvent);
  };

  pi.on('agent_start', forward);
  pi.on('agent_end', forward);
  pi.on('agent_settled', forward);
  pi.on('turn_start', forward);
  pi.on('turn_end', forward);
  pi.on('message_start', forward);
  pi.on('message_update', forward);
  pi.on('message_end', forward);
  pi.on('tool_execution_start', forward);
  pi.on('tool_execution_update', forward);
  pi.on('tool_execution_end', forward);
  pi.on('session_info_changed', forward);

  pi.registerCommand(NAVIGATE_COMMAND, {
    description: 'Navigate a Pi Web UI branch by bridge request',
    handler: async (token, ctx) => {
      if (active?.matches(ctx)) await active.navigate(token, ctx);
    },
  });

  pi.on('ui_prompt_start', (_event, ctx) => {
    if (active?.matches(ctx)) active.promptStart();
  });
  pi.on('ui_prompt_end', (_event, ctx) => {
    if (active?.matches(ctx)) active.promptEnd();
  });
  pi.on('model_select', (event, ctx) => {
    if (active?.matches(ctx)) active.modelSelected(event.model);
  });
  pi.on('thinking_level_select', (event, ctx) => {
    if (active?.matches(ctx)) active.thinkingLevelSelected(event.level);
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (active?.matches(ctx)) active.refreshCanonicalSnapshot(false);
  });
  pi.on('session_compact', (_event, ctx) => {
    if (active?.matches(ctx)) active.refreshCanonicalSnapshot(true);
  });
  pi.on('session_tree', (_event, ctx) => {
    if (active?.matches(ctx)) active.refreshCanonicalSnapshot(false);
  });
  pi.on('session_start', async (event, ctx) => {
    if (ctx.mode !== 'tui') return;
    await active?.stop(event.reason === 'startup' ? 'reload' : event.reason);
    active = undefined;
    try {
      const session = new NativeBridgeSession(pi, ctx);
      active = session;
      session.start();
    } catch (error) {
      ctx.ui.notify(
        `Pi Web UI sync disabled: ${error instanceof Error ? error.message : String(error)}. CLI remains active.`,
        'warning',
      );
    }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    const closing = active;
    if (!closing?.matches(ctx)) return;
    active = undefined;
    await closing.stop(event.reason);
  });
}
