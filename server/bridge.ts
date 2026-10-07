import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import {
  applyEvent,
  completionPreview,
  emptyProjection,
} from "../shared/transcript";
import type {
  PiCommand,
  PiSnapshot,
  PiState,
  PiUpdate,
  Projection,
  SessionRow,
} from "../shared/types";
import { canonicalFile, sessionOwner } from "./ownership";
import {
  JsonlConnection,
  guardJsonlFrames,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
} from "./jsonl";
import { readHistory } from "./history";

export { MAX_BUFFERED_BYTES, MAX_FRAME_BYTES };

const CLI_NOT_CONNECTED =
  "CLI not connected. Saved messages only. If this session is open in a terminal, run /reload once; this view will connect automatically.";

const cliState = (state: PiState, connected: boolean): PiState =>
  ({ ...state, owner: "cli", connected }) as PiState;
const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const alive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const expandHome = (path: string) =>
  path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type NativeConnection = {
  rpc: JsonlConnection;
  socket: Socket;
  peer: Peer;
  id: string;
  pid: number;
  sequence: number;
};

export type SharedSession = {
  command(command: PiCommand): Promise<unknown>;
  respond(response: RpcExtensionUIResponse): Promise<void>;
  subscribe(listener: (update: PiUpdate) => void): () => void;
};

export class CliBridge {
  readonly ready: Promise<void>;
  onChange: () => void = () => {};

  private readonly socketPath: string;
  private readonly leaseRoot: string;
  private readonly server: Server;
  private readonly isSdkOwned?: (file: string) => boolean;
  private readonly runtimes = new Map<string, CliRuntime>();
  private readonly sessions = new Map<string, CliRuntime>();
  private readonly files = new Map<
    string,
    { pid: number; runtime: CliRuntime }
  >();
  private readonly pids = new Map<number, CliRuntime>();
  private readonly peers = new Set<Peer>();
  private socketIdentity?: { dev: number; ino: number };
  private stopped = false;

  constructor(
    socketPath?: string,
    isOwned?: (file: string) => boolean,
    private readonly attachSdk?: (file: string) => Promise<SharedSession>,
  ) {
    const configured = socketPath ?? process.env.PI_WEBUI_SOCKET;
    const dataDir = process.env.PI_WEBUI_DATA_DIR
      ? expandHome(process.env.PI_WEBUI_DATA_DIR)
      : join(homedir(), ".local/state/pi-webui");
    this.socketPath = resolve(
      configured ? expandHome(configured) : join(dataDir, "bridge.sock"),
    );
    this.leaseRoot = join(dirname(this.socketPath), "leases");
    this.isSdkOwned = isOwned;
    this.server = createServer((socket) => this.accept(socket));
    this.ready = this.listen();
  }

  list(): SessionRow[] {
    this.pruneUnobserved();
    return [...this.runtimes.values()]
      .map((runtime) => ({
        ...runtime.state.session,
        kind: "cli" as const,
        running: runtime.transcript.running,
        waiting: runtime.nativePrompt,
        connected: Boolean(runtime.connection),
        completion: runtime.transcript.running ? undefined : runtime.completion,
        hasMessages: runtime.hasMessages || Boolean(runtime.state.stats?.userMessages),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  byFile(file: string): SessionRow | undefined {
    const runtime = this.files.get(canonicalFile(file))?.runtime;
    return runtime && this.list().find((row) => row.id === runtime.id);
  }

  forget(file: string): void {
    const path = canonicalFile(file);
    if (this.owns(path)) throw new Error("Close the CLI before removing this session");
    const runtime = this.files.get(path)?.runtime;
    if (!runtime) return;
    runtime.setConnected(false, "Session removed from this view.");
    this.files.delete(path);
    this.runtimes.delete(runtime.id);
    this.sessions.delete(runtime.sessionId);
    this.changed();
  }

  async watch(file: string): Promise<SessionRow> {
    const path = canonicalFile(file);
    const existing = this.byFile(path);
    if (existing) return existing;
    const saved = await readHistory(path);
    // A native hello may have arrived while the preview was being read.
    const attached = this.byFile(path);
    if (attached) return attached;
    const id = `cli:${saved.sessionId}`;
    const previous = this.sessions.get(saved.sessionId);
    if (previous) {
      if (previous.state.session.file !== path)
        throw new Error("Session ID belongs to a different history file");
      this.files.set(path, { pid: previous.pid, runtime: previous });
      return this.byFile(path)!;
    }
    const runtime = new CliRuntime(
      id,
      saved.sessionId,
      0,
      path,
      saved.cwd,
      saved.name,
      () => this.changed(),
      saved.updatedAt,
    );
    runtime.setSnapshot({
      state: {
        ...runtime.state,
        connected: false,
        loading: false,
        notice: CLI_NOT_CONNECTED,
      },
      transcript: saved.transcript,
    });
    this.runtimes.set(id, runtime);
    this.sessions.set(saved.sessionId, runtime);
    this.files.set(path, { pid: 0, runtime });
    this.changed();
    return this.byFile(path)!;
  }

  get(id: string): CliRuntime | undefined {
    this.pruneUnobserved();
    return this.runtimes.get(id);
  }

  private pruneUnobserved(): void {
    for (const runtime of this.runtimes.values())
      if (runtime.listeners.size === 0) runtime.pruneTranscript();
  }

  /** Native processes retain ownership while alive, even if their socket is down. */
  owns(file: string): boolean {
    const key = canonicalFile(file);
    const claim = sessionOwner(key, this.leaseRoot);
    if (claim?.kind === "cli") return true;
    const owner = this.files.get(key);
    if (!owner || owner.pid === 0) return false;
    if (alive(owner.pid)) return true;
    this.files.delete(key);
    owner.runtime.setConnected(false, "The native Pi process has exited.");
    return false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const peer of this.peers)
      peer.close(new Error("Pi Web UI bridge stopped"));
    this.peers.clear();
    await this.ready.catch(() => {});
    await new Promise<void>((done) => {
      if (!this.server.listening) return done();
      this.server.close(() => done());
    });
    if (this.socketIdentity) {
      try {
        const current = lstatSync(this.socketPath);
        if (
          current.isSocket() &&
          current.dev === this.socketIdentity.dev &&
          current.ino === this.socketIdentity.ino
        )
          unlinkSync(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const runtime of this.runtimes.values())
      runtime.failReady(new Error("Pi Web UI bridge stopped"));
  }

  private changed(): void {
    try {
      this.onChange();
    } catch {
      // Catalog observers must not interrupt the native event stream.
    }
  }

  private async listen(): Promise<void> {
    const directory = dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dirInfo = lstatSync(directory);
    if (!dirInfo.isDirectory() || dirInfo.uid !== process.getuid?.())
      throw new Error(
        `Bridge directory is not owned by this user: ${directory}`,
      );
    if ((dirInfo.mode & 0o777) !== 0o700)
      throw new Error(`Bridge directory must be private (0700): ${directory}`);
    try {
      await this.bind();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (!(await this.removeStaleSocket()))
        throw new Error(
          `Pi Web UI bridge socket is already active: ${this.socketPath}`,
        );
      await this.bind();
    }
    chmodSync(this.socketPath, 0o600);
    const info = lstatSync(this.socketPath);
    if (!info.isSocket())
      throw new Error(`Bridge path is not a socket: ${this.socketPath}`);
    this.socketIdentity = { dev: info.dev, ino: info.ino };
  }

  private bind(): Promise<void> {
    return new Promise((resolveListen, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolveListen();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
  }

  private async removeStaleSocket(): Promise<boolean> {
    let before;
    try {
      before = lstatSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!before.isSocket()) return false;
    const status = await new Promise<"active" | "stale" | "unknown">((done) => {
      const probe = connect(this.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        done("unknown");
      }, 300);
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        done("active");
      });
      probe.once("error", (error) => {
        clearTimeout(timer);
        done(
          (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
            ? "stale"
            : "unknown",
        );
      });
    });
    if (status !== "stale") return false;
    try {
      const current = lstatSync(this.socketPath);
      if (
        !current.isSocket() ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        return false;
      unlinkSync(this.socketPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.stopped) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    let peer!: Peer;
    peer = new Peer(socket, (record) => this.handle(peer, record));
    this.peers.add(peer);
    peer.onClose = () => {
      this.peers.delete(peer);
      peer.unsubscribe?.();
      peer.runtime?.disconnect(peer, "Native CLI disconnected", true);
      peer.connection = undefined;
    };
  }

  private acceptHello(peer: Peer, record: Record<string, any>): string {
    if (
      typeof record.id !== "string" ||
      typeof record.sessionId !== "string" ||
      !record.sessionId ||
      record.sessionId.length > 200 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      typeof record.cwd !== "string" ||
      !isAbsolute(record.cwd) ||
      (record.file !== undefined &&
        (typeof record.file !== "string" || !isAbsolute(record.file)))
    )
      throw new Error("Invalid native CLI hello");

    const id = `cli:${record.sessionId}`;
    const file = record.file ? canonicalFile(record.file) : undefined;
    if (file) {
      if (this.isSdkOwned?.(file))
        throw new Error(
          `Session file is already owned by the Pi Web UI SDK: ${file}`,
        );
      const claim = sessionOwner(file, this.leaseRoot);
      if (claim && (claim.kind !== "cli" || claim.pid !== record.pid))
        throw new Error(
          `Session file is already owned by ${claim.kind} process ${claim.pid}: ${file}`,
        );
      const owner = this.files.get(file);
      if (owner && owner.runtime.id !== id && alive(owner.pid))
        throw new Error(`Native Pi process ${owner.pid} already owns ${file}`);
      if (
        owner &&
        owner.runtime.id === id &&
        owner.pid !== record.pid &&
        alive(owner.pid)
      )
        throw new Error(`Native Pi process ${owner.pid} already owns ${file}`);
    }

    const existing = this.sessions.get(record.sessionId);
    if (existing) {
      if (existing.pid !== record.pid && alive(existing.pid))
        throw new Error(
          `Native Pi session ${record.sessionId} is already live in process ${existing.pid}`,
        );
      const oldFile = existing.state.session.file;
      if (oldFile && file && canonicalFile(oldFile) !== file)
        throw new Error(
          `Native Pi session ${record.sessionId} changed its session file`,
        );
      if (existing.connection)
        throw new Error(
          `Native Pi session ${record.sessionId} already has a live bridge connection`,
        );
    }

    const previous = this.pids.get(record.pid);
    if (previous && previous !== existing) this.releasePid(record.pid);
    const runtime =
      existing ??
      new CliRuntime(
        id,
        record.sessionId,
        record.pid,
        file,
        record.cwd,
        record.name,
        () => this.changed(),
      );
    runtime.pid = record.pid;
    runtime.setSnapshotRequester(() => this.requestSnapshot(runtime));
    this.runtimes.set(id, runtime);
    this.sessions.set(record.sessionId, runtime);
    this.pids.set(record.pid, runtime);
    if (file) this.files.set(file, { pid: record.pid, runtime });
    const connection: NativeConnection = {
      rpc: peer.rpc,
      socket: peer.socket,
      peer,
      id: randomUUID(),
      pid: record.pid,
      sequence: -1,
    };
    peer.runtime = runtime;
    peer.connection = connection;
    runtime.connection = connection;
    runtime.state = cliState(runtime.state, true);
    runtime.publish({ kind: "state", value: runtime.state });
    this.changed();
    return connection.id;
  }

  private releasePid(pid: number, switched = true): void {
    const runtime = this.pids.get(pid);
    if (!runtime) return;
    this.pids.delete(pid);
    const file = runtime.state.session.file;
    if (file && this.files.get(canonicalFile(file))?.runtime === runtime)
      this.files.delete(canonicalFile(file));
    runtime.switchAway(switched);
    if (runtime.connection) {
      const connection = runtime.connection;
      runtime.connection = undefined;
      if (!runtime.hasPendingForkReply) {
        connection.rpc.close(new Error("Native Pi session switched"));
        connection.socket.destroy();
      }
    }
  }

  private async attach(peer: Peer, record: Record<string, any>): Promise<void> {
    if (peer.runtime || peer.shared || peer.attaching)
      throw new Error("This connection is already attached");
    if (typeof record.file !== "string" || !isAbsolute(record.file))
      throw new Error("Invalid session file");
    peer.attaching = true;
    try {
      const file = canonicalFile(record.file);
      const native = this.files.get(file)?.runtime;
      const shared = native?.connection
        ? native
        : await this.attachSdk?.(file);
      if (!shared) throw new Error("No running session owns this file");
      if (peer.socket.destroyed) return;
      peer.shared = shared;
      peer.unsubscribe = shared.subscribe((value) => peer.send({ type: "update", value }));
      peer.respond(record, true, null);
    } finally {
      peer.attaching = false;
    }
  }

  private handle(peer: Peer, raw: unknown): void {
    if (!isObject(raw)) return peer.reject(raw, "Invalid bridge record");
    if (raw.type === "attach") {
      void this.attach(peer, raw).catch((error) => peer.reject(raw, errorMessage(error)));
      return;
    }
    if (peer.shared) {
      let operation: Promise<unknown>;
      if (raw.type === "command" && isObject(raw.command))
        operation = peer.shared.command(raw.command as PiCommand);
      else if (raw.type === "ui_response" && isObject(raw.response))
        operation = peer.shared.respond(raw.response as RpcExtensionUIResponse);
      else return peer.reject(raw, "Unsupported shared session request");
      void operation.then(
        (result) => peer.respond(raw, true, result),
        (error) => peer.reject(raw, errorMessage(error)),
      );
      return;
    }
    if (raw.type === "hello") {
      try {
        peer.respond(raw, true, { connectionId: this.acceptHello(peer, raw) });
      } catch (error) {
        peer.reject(raw, errorMessage(error));
      }
      return;
    }
    const runtime = peer.runtime;
    const connection = peer.connection;
    if (
      !runtime ||
      !connection ||
      runtime.connection !== connection ||
      raw.connectionId !== connection.id
    )
      return;
    if (raw.type === "release") {
      const switched = ["new", "resume", "fork"].includes(raw.reason);
      runtime.disconnect(
        peer,
        raw.reason || "Native Pi session shut down",
        true,
        switched,
      );
      peer.connection = undefined;
      if (switched || raw.reason === "quit")
        this.releasePid(connection.pid, switched);
      this.changed();
      return;
    }
    if (
      !Number.isSafeInteger(raw.sequence) ||
      raw.sequence <= connection.sequence
    )
      return;
    connection.sequence = raw.sequence;
    if (raw.type === "snapshot") {
      if (
        !isObject(raw.value) ||
        !isObject(raw.value.state) ||
        !isObject(raw.value.transcript)
      ) {
        this.protocolError(peer, "Invalid PiSnapshot");
        return;
      }
      this.applySnapshot(runtime, peer, raw.value as PiSnapshot);
      return;
    }
    if (raw.type !== "update" || !isObject(raw.value)) {
      this.protocolError(peer, "Unknown bridge record");
      return;
    }
    const update = raw.value as PiUpdate;
    if (update.kind === "state") {
      if (update.value.session.id !== runtime.id) {
        this.protocolError(peer, "State session identity changed");
        return;
      }
      if (!this.updateFile(runtime, peer, update.value.session.file)) return;
      const oldName = runtime.state.session.name;
      const oldUpdatedAt = runtime.state.session.updatedAt;
      runtime.state = cliState(
        {
          ...update.value,
          session: {
            ...update.value.session,
            file: runtime.state.session.file,
            kind: "cli",
          },
        },
        true,
      );
      runtime.nativePrompt = Boolean(
        runtime.state.notice?.startsWith("Answer this prompt in the terminal"),
      );
      runtime.publish({ kind: "state", value: runtime.state });
      if (
        oldName !== runtime.state.session.name ||
        oldUpdatedAt !== runtime.state.session.updatedAt
      )
        this.changed();
    } else if (update.kind === "event") {
      runtime.applyEvent(update.value);
      if (update.value.type === "session_info_changed") {
        runtime.state = cliState(
          {
            ...runtime.state,
            session: {
              ...runtime.state.session,
              name: update.value.name || "CLI session",
            },
          },
          true,
        );
        this.changed();
      } else if (
        update.value.type === "agent_start" ||
        update.value.type === "agent_settled"
      ) {
        this.changed();
      }
      runtime.publish(update);
    } else {
      this.protocolError(peer, "Unexpected nested snapshot update");
      return;
    }
  }

  private async requestSnapshot(runtime: CliRuntime): Promise<void> {
    const connection = runtime.connection;
    if (!connection) return;
    // The sequenced snapshot is applied synchronously before the RPC acknowledgement.
    await connection.rpc.request({ type: "snapshot_request" }, 10_000);
  }

  private applySnapshot(
    runtime: CliRuntime,
    peer: Peer,
    snapshot: PiSnapshot,
  ): boolean {
    if (snapshot.state.session.id !== runtime.id) {
      this.protocolError(peer, "Snapshot session identity changed");
      return false;
    }
    if (!this.updateFile(runtime, peer, snapshot.state.session.file))
      return false;
    runtime.setSnapshot({
      ...snapshot,
      state: {
        ...snapshot.state,
        session: {
          ...snapshot.state.session,
          file: runtime.state.session.file,
          kind: "cli",
        },
      },
    });
    this.changed();
    return true;
  }

  private updateFile(
    runtime: CliRuntime,
    peer: Peer,
    incoming?: string,
  ): boolean {
    if (!incoming) return true;
    if (!isAbsolute(incoming))
      return this.protocolError(peer, "Session file must be absolute");
    let file: string;
    try {
      file = canonicalFile(incoming);
    } catch (error) {
      return this.protocolError(peer, errorMessage(error));
    }
    const current = runtime.state.session.file;
    if (current && canonicalFile(current) !== file)
      return this.protocolError(
        peer,
        "Native Pi session file changed without a session switch",
      );
    if (current) return true;
    const claim = sessionOwner(file, this.leaseRoot);
    let sdkOwns = false;
    try {
      sdkOwns = this.isSdkOwned?.(file) ?? false;
    } catch (error) {
      return this.protocolError(
        peer,
        `Could not verify SDK session ownership: ${errorMessage(error)}`,
      );
    }
    if (
      sdkOwns ||
      (claim && (claim.kind !== "cli" || claim.pid !== runtime.pid))
    )
      return this.protocolError(peer, `Session file is already owned: ${file}`);
    const owner = this.files.get(file);
    if (owner && owner.runtime !== runtime && alive(owner.pid))
      return this.protocolError(
        peer,
        `Session file is already owned by native Pi process ${owner.pid}`,
      );
    runtime.state = cliState(
      {
        ...runtime.state,
        session: { ...runtime.state.session, file },
      },
      true,
    );
    this.files.set(file, { pid: runtime.pid, runtime });
    this.changed();
    return true;
  }

  private protocolError(peer: Peer, message: string): false {
    peer.send({ type: "bridge_error", error: message });
    peer.runtime?.fail(message);
    peer.socket.destroy(new Error(message));
    return false;
  }
}

class Peer {
  readonly rpc: JsonlConnection;
  runtime?: CliRuntime;
  connection?: NativeConnection;
  shared?: SharedSession;
  unsubscribe?: () => void;
  attaching = false;
  onClose: () => void = () => {};
  private outputBytes = 0;
  private closed = false;

  constructor(
    readonly socket: Socket,
    onEvent: (record: unknown) => void,
  ) {
    this.rpc = new JsonlConnection(socket, guardJsonlFrames(socket));
    this.rpc.onEvent = onEvent;
    this.rpc.onClose = () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    };
  }

  respond(record: unknown, success: boolean, data: unknown): void {
    if (!isObject(record) || typeof record.id !== "string") return;
    this.send(
      success
        ? { id: record.id, type: "response", success: true, data }
        : { id: record.id, type: "response", success: false, error: data },
    );
  }

  reject(record: unknown, message: string): void {
    this.respond(record, false, message);
  }

  send(record: object): void {
    if (this.closed || this.socket.destroyed) return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (
      bytes > MAX_FRAME_BYTES ||
      (this.outputBytes > 0 && this.outputBytes + bytes > MAX_BUFFERED_BYTES)
    ) {
      this.socket.destroy(new Error("Bridge output buffer limit exceeded"));
      return;
    }
    this.outputBytes += bytes;
    this.socket.write(line, (error) => {
      this.outputBytes -= bytes;
      if (error) this.socket.destroy(error);
    });
  }

  close(error: Error): void {
    this.rpc.close(error);
    this.socket.destroy(error);
  }
}

class CliRuntime {
  readonly ready: Promise<void>;
  readonly listeners = new Set<(update: PiUpdate) => void>();
  state: PiState;
  transcript: Projection = emptyProjection();
  completion?: SessionRow["completion"];
  hasMessages = false;
  nativePrompt = false;
  pid: number;
  connection?: NativeConnection;
  private readyState = deferred();
  private readySettled = false;
  private commandInFlight?: PiCommand["type"];
  private pendingSnapshotListeners = new Set<(update: PiUpdate) => void>();
  private snapshotRequester?: () => Promise<void>;
  private snapshotRequest?: Promise<void>;

  constructor(
    readonly id: string,
    readonly sessionId: string,
    pid: number,
    file: string | undefined,
    cwd: string,
    name: string | undefined,
    private onChange: () => void,
    updatedAt: number = Date.now(),
  ) {
    this.pid = pid;
    this.ready = this.readyState.promise;
    this.state = cliState(
      {
        session: {
          kind: "cli",
          id,
          cwd,
          name: name || "CLI session",
          updatedAt,
          ...(file ? { file } : {}),
        },
        loading: true,
        models: [],
        levels: [],
        commands: [],
        dialogs: [],
        statuses: {},
        thinkingLevel: "off",
      } as PiState,
      true,
    );
  }

  get hasPendingForkReply(): boolean {
    return this.commandInFlight === "fork";
  }

  snapshot(): PiSnapshot {
    return { state: this.state, transcript: this.transcript };
  }

  subscribe(listener: (update: PiUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.connection || this.state.session.file) {
      this.pendingSnapshotListeners.add(listener);
      this.requestCurrentSnapshot();
    } else {
      this.deliverSnapshot(listener);
    }
    return () => {
      this.listeners.delete(listener);
      this.pendingSnapshotListeners.delete(listener);
      this.pruneTranscript();
    };
  }

  setSnapshotRequester(requester: () => Promise<void>): void {
    this.snapshotRequester = requester;
  }

  private requestCurrentSnapshot(): void {
    if (this.snapshotRequest) return;
    const request = this.connection
      ? this.snapshotRequester?.()
      : this.readSavedPreview();
    this.snapshotRequest = Promise.resolve(request)
      .catch((error) => {
        this.state = {
          ...this.state,
          error: `Could not refresh CLI history: ${errorMessage(error)}`,
        };
      })
      .finally(() => {
        this.snapshotRequest = undefined;
        this.finishPendingSnapshotListeners();
      });
  }

  private async readSavedPreview(): Promise<void> {
    const file = this.state.session.file;
    if (!file) return;
    const saved = await readHistory(file);
    if (this.connection) return;
    this.setSnapshot({
      state: {
        ...this.state,
        connected: false,
        loading: false,
        notice: CLI_NOT_CONNECTED,
      },
      transcript: saved.transcript,
    });
  }

  private deliverSnapshot(listener: (update: PiUpdate) => void): void {
    try {
      listener({ kind: "snapshot", value: this.snapshot() });
    } catch {
      // A browser listener must not interrupt native session delivery.
    }
  }

  private finishPendingSnapshotListeners(): void {
    for (const listener of this.pendingSnapshotListeners) {
      this.pendingSnapshotListeners.delete(listener);
      if (this.listeners.has(listener)) this.deliverSnapshot(listener);
    }
  }

  publish(update: PiUpdate): void {
    for (const listener of this.listeners) {
      if (this.pendingSnapshotListeners.has(listener)) continue;
      try {
        listener(update);
      } catch {
        // A browser listener must not interrupt native session delivery.
      }
    }
  }

  setSnapshot(snapshot: PiSnapshot): void {
    this.state = cliState(snapshot.state, Boolean(this.connection));
    this.hasMessages ||= snapshot.transcript.items.some((item) => item.message.role === "user");
    this.completion = completionPreview({ ...snapshot.transcript, running: false });
    this.transcript = this.listeners.size
      ? snapshot.transcript
      : { ...emptyProjection(), running: snapshot.transcript.running };
    this.nativePrompt = Boolean(
      this.state.notice?.startsWith("Answer this prompt in the terminal"),
    );
    this.markReady();
    this.publish({ kind: "snapshot", value: this.snapshot() });
    this.finishPendingSnapshotListeners();
  }

  applyEvent(event: Extract<PiUpdate, { kind: "event" }>["value"]): void {
    if (event.type === "agent_start") this.completion = undefined;
    if (event.type === "message_end") {
      if (event.message.role === "user") {
        this.hasMessages = true;
        this.completion = undefined;
      } else if (event.message.role === "assistant") {
        this.completion = completionPreview({
          ...emptyProjection(), items: [{ id: String(event.message.timestamp), message: event.message }],
        });
      }
    }
    if (this.listeners.size) {
      this.transcript = applyEvent(this.transcript, event);
      return;
    }
    let running = this.transcript.running;
    if (event.type === "agent_start") running = true;
    if (event.type === "agent_settled") running = false;
    this.transcript = { ...emptyProjection(), running };
  }

  pruneTranscript(): void {
    if (this.listeners.size === 0)
      this.transcript = {
        ...emptyProjection(),
        running: this.transcript.running,
      };
  }

  markReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyState.resolve();
  }

  failReady(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyState.reject(error);
  }

  setConnected(connected: boolean, notice?: string): void {
    this.state = cliState(
      { ...this.state, notice: notice ?? this.state.notice },
      connected,
    );
    this.pruneTranscript();
    this.publish({ kind: "state", value: this.state });
    this.onChange();
  }

  fail(message: string): void {
    this.state = cliState(
      { ...this.state, loading: false, error: message },
      false,
    );
    this.publish({ kind: "state", value: this.state });
    this.onChange();
  }

  disconnect(
    peer: Peer,
    reason: string,
    notify: boolean,
    switched = false,
  ): void {
    if (this.connection?.rpc !== peer.rpc) return;
    this.connection = undefined;
    if (!this.readySettled && switched)
      this.failReady(
        new Error(`Native Pi session switched before snapshot: ${reason}`),
      );
    this.state = cliState(
      {
        ...this.state,
        notice: switched
          ? "This CLI session was switched in the terminal."
          : this.state.notice,
      },
      false,
    );
    this.pruneTranscript();
    if (notify) this.publish({ kind: "state", value: this.state });
    this.onChange();
  }

  switchAway(switched: boolean): void {
    this.state = cliState(
      {
        ...this.state,
        ...(switched
          ? { notice: "This CLI session was switched in the terminal." }
          : {}),
      },
      false,
    );
    this.publish({ kind: "state", value: this.state });
    this.onChange();
  }

  async command(command: PiCommand): Promise<unknown> {
    await this.ready;
    if (!this.connection) throw new Error("Native Pi session is disconnected");
    if (this.commandInFlight)
      throw new Error("Another native Pi command is in progress");
    const type = (command as { type: string }).type;
    if (
      ![
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "set_model",
        "set_thinking_level",
        "set_session_name",
        "compact",
        "get_entries",
        "get_tree",
        "navigate_tree",
        "fork",
      ].includes(type)
    )
      throw new Error(
        type === "clear_queue"
          ? (this.state.capabilities?.queueRecoveryReason ??
              "clear_queue is unsupported for native TUI sessions: installed Pi has no public queue read/clear actions")
          : `Unsupported native CLI command: ${type}`,
      );
    if (Buffer.byteLength(JSON.stringify(command)) > MAX_FRAME_BYTES)
      throw new Error("Native CLI command exceeds 32 MiB");
    this.commandInFlight = command.type;
    try {
      return await this.connection.rpc.request(
        { type: "command", command },
        type === "compact" ? 300_000 : 30_000,
      );
    } finally {
      this.commandInFlight = undefined;
    }
  }

  async respond(_response: RpcExtensionUIResponse): Promise<void> {
    throw new Error("Native TUI dialogs must be answered in the terminal");
  }
}
