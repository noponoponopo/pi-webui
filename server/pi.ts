import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeResult,
  type SessionStartEvent,
  type InlineExtension,
  type Theme as PiTheme,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model as PiModel } from "@earendil-works/pi-ai";
import type { SessionClaim } from "./ownership";
import { canonicalFile, claimSessionFile } from "./ownership";
import {
  activeHistory,
  applyEvent,
  completionPreview,
  emptyProjection,
} from "../shared/transcript";
import type {
  HistoryRow,
  Model,
  PiCommand,
  PiEvent,
  PiSnapshot,
  PiState,
  PiUpdate,
  Session,
  SessionRow,
} from "../shared/types";
import { listHistory, sessionMetadata } from "./history";
import { noColorTheme, SdkUI } from "./sdk-ui";
import { directory, Store } from "./store";
import { sessionEntries, toPiEvent } from "./session-events";

export type PiSessionsOptions = {
  isOwned?: (file: string) => boolean;
  agentDir?: string;
  ownershipDir?: string;
  extensionFactories?: InlineExtension[];
};

const publicModel = (model: PiModel<any>): Model => ({
  id: model.id,
  provider: model.provider,
  name: model.name,
  reasoning: model.reasoning,
  contextWindow: model.contextWindow,
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function sameFile(left: string, right: string): boolean {
  try {
    return canonicalFile(left) === canonicalFile(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function sessionNameFromPrompt(message: string, hasImages: boolean): string {
  return (
    message.trim().split("\n")[0].slice(0, 80) ||
    (hasImages ? "Image" : "New session")
  );
}

class PiRuntime {
  readonly listeners = new Set<(update: PiUpdate) => void>();
  readonly ready: Promise<void>;
  readonly file: string;
  transcript = emptyProjection();
  state: PiState;
  session?: AgentSession;
  runtimeResult?: CreateAgentSessionRuntimeResult;
  private transitioning = false;
  private ui?: SdkUI;
  private unsubscribe?: () => void;
  private stopping = false;
  private leaseHeld = true;
  private stopPromise?: Promise<void>;
  lastActivity = Date.now();

  constructor(
    private readonly owner: PiSessions,
    session: Session,
    readonly sessionManager: SessionManager,
    private readonly claim: SessionClaim,
    sessionStartEvent?: SessionStartEvent,
  ) {
    this.file = claim.file;
    this.state = {
      owner: "web",
      connected: false,
      session,
      loading: true,
      models: [],
      levels: [],
      commands: [],
      dialogs: [],
      statuses: {},
      thinkingLevel: "off",
    };
    this.ready = owner
      .initializeRuntime(this, sessionStartEvent)
      .catch((error) => this.fail(error));
  }

  get ownsFile(): boolean {
    return this.leaseHeld;
  }

  snapshot(): PiSnapshot {
    return { state: this.state, transcript: this.transcript };
  }

  publish(update: PiUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        // A disconnected event consumer must not interrupt the session.
      }
    }
  }

  assertCanInitialize(): void {
    if (this.stopping) throw new Error("Session runtime is closing");
    this.assertOwner();
  }

  assertOwner(): void {
    this.claim.assertOwner();
    this.owner.assertNotOwned(this.file);
  }

  getUIContext() {
    if (!this.ui) throw new Error("Pi extension UI is not initialized");
    return this.ui.context;
  }

  extensionError(error: string, extensionPath: string, event: string): void {
    this.onEvent({ type: "extension_error", error, extensionPath, event });
  }

  attachSession(session: AgentSession, theme: PiTheme): void {
    this.session = session;
    this.ui = new SdkUI(
      (event) => this.onEvent(event),
      (id) => this.removeDialog(id),
      theme,
    );
    this.unsubscribe = session.subscribe((event) => {
      const update = toPiEvent(event);
      if (update) this.onEvent(update);
    });
  }

  finishInitialization(notice?: string): void {
    const session = this.requireSession();
    this.transcript = {
      ...this.transcript,
      items: activeHistory(
        this.sessionManager.getEntries(),
        this.sessionManager.getLeafId(),
      ),
      running: !session.isIdle,
      queue: this.readQueue(),
    };
    this.state = {
      ...this.state,
      loading: false,
      connected: true,
      error: undefined,
      notice: notice ?? this.state.notice,
    };
    this.updateState(false);
    this.publish({ kind: "snapshot", value: this.snapshot() });
    this.owner.markChanged();
  }

  async refresh(): Promise<void> {
    if (this.session) this.updateState();
  }

  async respond(response: RpcExtensionUIResponse): Promise<void> {
    const dialog = this.state.dialogs.find((item) => item.id === response.id);
    if (!dialog)
      throw new Error(
        "This dialog has expired or was answered in another window",
      );
    if (
      dialog.method === "select" &&
      "value" in response &&
      !dialog.options.includes(response.value)
    )
      throw new Error("Invalid choice");
    this.assertOwner();
    if (!this.ui?.respond(response)) throw new Error("Invalid dialog response");
  }

  async command(command: PiCommand): Promise<unknown> {
    await this.ready;
    if (this.state.error) throw new Error(this.state.error);
    if (this.stopping) throw new Error("Session runtime is closing");
    if (this.transitioning)
      throw new Error("Pi session replacement is in progress");
    this.assertOwner();
    const session = this.requireSession();

    switch (command.type) {
      case "get_entries":
        return sessionEntries(this.sessionManager, command.since);
      case "get_tree":
        return {
          tree: this.sessionManager.getTree(),
          leafId: this.sessionManager.getLeafId(),
        };
      case "get_fork_messages":
        return { messages: session.getUserMessagesForForking() };
      case "fork": {
        this.transitioning = true;
        try {
          return await this.owner.fork(this, command.entryId, command.position);
        } finally {
          this.transitioning = false;
        }
      }
      case "navigate_tree": {
        if (command.targetId === this.sessionManager.getLeafId())
          return { cancelled: false, leafId: command.targetId };
        if (!this.sessionManager.getEntry(command.targetId))
          throw new Error(`Entry ${command.targetId} not found`);
        if (command.targetId !== this.sessionManager.getLeafId() && session.isStreaming)
          await session.abort();
        const result = await session.navigateTree(command.targetId, {
          summarize: false,
        });
        this.refreshTranscript();
        await this.refresh();
        this.publish({ kind: "snapshot", value: this.snapshot() });
        this.owner.markChanged();
        return { ...result, leafId: this.sessionManager.getLeafId() };
      }
      case "prompt":
        return this.prompt(
          command.message,
          command.images,
          command.streamingBehavior,
        );
      case "steer":
        return this.prompt(command.message, command.images, "steer");
      case "follow_up":
        return this.prompt(command.message, command.images, "followUp");
      case "abort": {
        session.clearQueue();
        await session.abort();
        await this.refresh();
        return null;
      }
      case "clear_queue": {
        const queue = this.readQueue();
        const from = command.from;
        if (from && (
          !Number.isSafeInteger(from.index) || from.index < 0 ||
          from.index >= queue[from.mode].length ||
          (['steering', 'followUp'] as const).some((mode) =>
            JSON.stringify(from.queue[mode]) !== JSON.stringify(queue[mode]),
          )
        )) throw new Error("Pending messages changed; select the input again");
        const keepSteering = from
          ? (from.mode === "steering" ? from.index : queue.steering.length)
          : 0;
        const keepFollowUp = from?.mode === "followUp" ? from.index : 0;
        const agent = session.agent;
        let rawSteering: ReturnType<typeof agent.peekQueuedMessages> = [];
        let rawFollowUp: ReturnType<typeof agent.peekQueuedMessages> = [];
        const steeringMode = agent.steeringMode;
        const followUpMode = agent.followUpMode;
        try {
          agent.steeringMode = agent.followUpMode = "all";
          const first = agent.peekQueuedMessages();
          if (queue.steering.length) {
            rawSteering = first;
            agent.clearSteeringQueue();
            try {
              rawFollowUp = agent.peekQueuedMessages();
            } finally {
              for (const message of first) agent.steer(message);
            }
          } else rawFollowUp = first;
          if (from && (rawSteering.length !== queue.steering.length || rawFollowUp.length !== queue.followUp.length))
            throw new Error("Pending messages contain non-user content; text-only recovery would discard it");
          const queued = [...rawSteering.slice(keepSteering), ...rawFollowUp.slice(keepFollowUp)];
          if (queued.some((message) => message.role !== "user"))
            throw new Error(
              "Pending messages contain non-user content; text-only recovery would discard it",
            );
          if (
            queued.some(
              (message) =>
                message.role === "user" &&
                typeof message.content !== "string" &&
                message.content.some((block) => block.type === "image"),
            )
          )
            throw new Error(
              "Pending messages contain images; text-only recovery would discard them",
            );
        } finally {
          agent.steeringMode = steeringMode;
          agent.followUpMode = followUpMode;
        }
        const result = {
          steering: queue.steering.slice(keepSteering),
          followUp: queue.followUp.slice(keepFollowUp),
        };
        if (!from) session.clearQueue();
        else {
          agent.clearAllQueues();
          for (const message of rawSteering.slice(0, keepSteering)) agent.steer(message);
          for (const message of rawFollowUp.slice(0, keepFollowUp)) agent.followUp(message);
          // Pi exposes no partial clear; keep its text queue in sync without re-running input hooks.
          (session.getSteeringMessages() as string[]).splice(keepSteering);
          (session.getFollowUpMessages() as string[]).splice(keepFollowUp);
          this.onEvent({ type: "queue_update", ...this.readQueue() });
        }
        await this.refresh();
        return result;
      }
      case "set_model": {
        const model = session.modelRuntime
          .getAvailableSnapshot()
          .find(
            (candidate) =>
              candidate.provider === command.provider &&
              candidate.id === command.modelId,
          );
        if (!model)
          throw new Error(
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        await session.setModel(model);
        await this.refresh();
        return publicModel(model);
      }
      case "set_thinking_level":
        session.setThinkingLevel(command.level);
        await this.refresh();
        return null;
      case "set_session_name": {
        session.setSessionName(command.name);
        this.updateSessionName(command.name);
        return null;
      }
      case "compact": {
        const result = await session.compact(command.customInstructions);
        this.refreshTranscript();
        await this.refresh();
        this.publish({ kind: "snapshot", value: this.snapshot() });
        return result;
      }
      case "set_steering_mode":
        session.setSteeringMode(command.mode);
        await this.refresh();
        return null;
      case "set_follow_up_mode":
        session.setFollowUpMode(command.mode);
        await this.refresh();
        return null;
      case "set_auto_compaction":
        session.setAutoCompactionEnabled(command.enabled);
        await this.refresh();
        return null;
      default:
        throw new Error(`Unsupported Pi command: ${command.type}`);
    }
  }

  detachForReplacement(): void {
    this.unsubscribe?.();
    this.ui?.dispose();
    this.session = undefined;
    this.runtimeResult = undefined;
    this.releaseLease();
    this.state = { ...this.state, connected: false, loading: false };
    this.publish({ kind: "state", value: this.state });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.ui?.dispose();
    this.stopPromise = (async () => {
      try {
        await this.ready;
        this.unsubscribe?.();
        try {
          if (this.session && !this.session.isIdle) await this.session.abort();
        } finally {
          this.session?.dispose();
        }
      } finally {
        this.ui?.dispose();
        this.releaseLease();
        this.state = { ...this.state, connected: false, loading: false };
        this.publish({ kind: "state", value: this.state });
      }
    })();
    return this.stopPromise;
  }

  private async prompt(
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<unknown> {
    this.assertOwner();
    const session = this.requireSession();
    let accepted = false;
    let resolveAccepted!: (
      disposition: "handled" | "queued" | "started",
    ) => void;
    let rejectAccepted!: (error: unknown) => void;
    const acceptance = new Promise<"handled" | "queued" | "started">(
      (resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      },
    );
    const run = session.prompt(message, {
      images,
      streamingBehavior,
      source: "rpc",
      preflightResult: (disposition) => {
        accepted = true;
        resolveAccepted(disposition);
      },
    });
    void run.catch((error) => {
      if (!this.stopping) {
        this.state = { ...this.state, notice: errorMessage(error) };
        this.publish({ kind: "state", value: this.state });
      }
      if (!accepted) rejectAccepted(error);
    });

    const disposition = await acceptance;
    if (this.state.session.name === "New session" && disposition !== "queued") {
      this.assertOwner();
      session.setSessionName(
        sessionNameFromPrompt(message, Boolean(images?.length)),
      );
    }
    this.state = {
      ...this.state,
      session: { ...this.state.session, updatedAt: Date.now() },
    };
    this.owner.store.save(this.state.session);
    await this.refresh();
    this.owner.markChanged();
    return disposition;
  }

  private onEvent(event: PiEvent): void {
    if (this.stopping) return;
    this.lastActivity = Date.now();

    if (event.type === "extension_ui_request") this.handleUIRequest(event);
    this.transcript = applyEvent(this.transcript, event);
    if (
      !this.state.session.hasMessages &&
      this.transcript.items.some((item) => item.message.role === "user")
    ) {
      this.state.session = { ...this.state.session, hasMessages: true };
      this.owner.store.save(this.state.session);
      this.owner.markChanged();
    }
    this.publish({ kind: "event", value: event });

    if (event.type === "agent_start") {
      this.touchSession();
      this.owner.markChanged();
    } else if (event.type === "message_end") {
      // SDK persists the message after notifying listeners.
      queueMicrotask(() => {
        if (!this.stopping) this.updateState();
      });
    } else if (event.type === "agent_settled") {
      this.refreshTranscript();
      this.updateState();
      this.publish({ kind: "snapshot", value: this.snapshot() });
      this.touchSession();
      this.owner.markChanged();
    } else if (event.type === "session_info_changed") {
      this.updateSessionName(event.name ?? "New session");
    } else if (event.type === "thinking_level_changed") {
      this.updateState();
    } else if (event.type === "entry_appended") {
      this.refreshTranscript();
      this.publish({ kind: "snapshot", value: this.snapshot() });
    } else if (event.type === "extension_error") {
      this.state = { ...this.state, notice: event.error };
      this.publish({ kind: "state", value: this.state });
    }
  }

  private handleUIRequest(event: RpcExtensionUIRequest): void {
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      if (!this.state.dialogs.some((item) => item.id === event.id))
        this.state = { ...this.state, dialogs: [...this.state.dialogs, event] };
    } else if (event.method === "notify") {
      this.state = { ...this.state, notice: event.message };
    } else if (event.method === "setStatus") {
      this.state = {
        ...this.state,
        statuses: {
          ...this.state.statuses,
          [event.statusKey]: event.statusText ?? "",
        },
      };
    } else if (event.method === "setWidget") {
      this.state = {
        ...this.state,
        statuses: {
          ...this.state.statuses,
          [event.widgetKey]: event.widgetLines?.join("\n") ?? "",
        },
      };
    }
    this.publish({ kind: "state", value: this.state });
  }

  private removeDialog(id: string): void {
    if (!this.state.dialogs.some((dialog) => dialog.id === id)) return;
    this.state = {
      ...this.state,
      dialogs: this.state.dialogs.filter((dialog) => dialog.id !== id),
    };
    this.publish({ kind: "state", value: this.state });
  }

  private refreshTranscript(): void {
    const running = Boolean(this.session && !this.session.isIdle);
    this.transcript = {
      ...this.transcript,
      items: activeHistory(
        this.sessionManager.getEntries(),
        this.sessionManager.getLeafId(),
      ),
      partial: running ? this.transcript.partial : undefined,
      running,
      queue: this.readQueue(),
      tools: running
        ? this.transcript.tools
        : Object.fromEntries(
            Object.entries(this.transcript.tools).map(([id, tool]) => [
              id,
              { ...tool, running: false },
            ]),
          ),
    };
  }

  private readQueue() {
    return {
      steering: [...(this.session?.getSteeringMessages() ?? [])],
      followUp: [...(this.session?.getFollowUpMessages() ?? [])],
    };
  }

  private updateState(save = true): void {
    const session = this.session;
    if (!session) return;
    const savedSession: Session = {
      ...this.state.session,
      file:
        session.sessionFile ??
        this.sessionManager.getSessionFile() ??
        this.state.session.file,
      name: session.sessionName || this.state.session.name,
      cwd: this.sessionManager.getCwd(),
    };
    if (save) this.owner.store.save(savedSession);
    const commands: PiState["commands"] = [
      ...session.extensionRunner
        .getRegisteredCommands()
        .map(({ invocationName, description }) => ({
          name: invocationName,
          description,
        })),
      ...session.promptTemplates.map(({ name, description }) => ({
        name,
        description,
      })),
      ...session.resourceLoader
        .getSkills()
        .skills.map(({ name, description }) => ({
          name: `skill:${name}`,
          description,
        })),
    ];
    this.state = {
      ...this.state,
      session: savedSession,
      model: session.model ? publicModel(session.model) : undefined,
      models: session.modelRuntime.getAvailableSnapshot().map(publicModel),
      thinkingLevel: session.thinkingLevel,
      levels: session.getAvailableThinkingLevels(),
      commands,
      stats: session.getSessionStats(),
      leafId: this.sessionManager.getLeafId(),
      capabilities: { queueRecovery: true, treeNavigation: true },
    };
    this.publish({ kind: "state", value: this.state });
  }

  private updateSessionName(name: string): void {
    this.state = { ...this.state, session: { ...this.state.session, name } };
    this.owner.store.save(this.state.session);
    this.publish({ kind: "state", value: this.state });
    this.owner.markChanged();
  }

  private touchSession(): void {
    this.state = {
      ...this.state,
      session: { ...this.state.session, updatedAt: Date.now() },
    };
    this.owner.store.save(this.state.session);
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Pi session is not initialized");
    return this.session;
  }

  private fail(error: unknown): void {
    this.unsubscribe?.();
    this.ui?.dispose();
    try {
      this.session?.dispose();
    } catch {
      // Initialization failed; still release the file lease below.
    }
    this.releaseLease();
    this.transcript = { ...this.transcript, running: false };
    this.state = {
      ...this.state,
      loading: false,
      connected: false,
      error: errorMessage(error),
    };
    this.publish({ kind: "snapshot", value: this.snapshot() });
    this.owner.markChanged();
  }

  private releaseLease(): void {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    this.claim.release();
  }
}

export class PiSessions {
  readonly agentDir: string;
  readonly ownershipDir: string;
  onChange: () => void = () => {};
  private readonly runtimes = new Map<string, PiRuntime>();
  private readonly runtimesByFile = new Map<string, PiRuntime>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly restarting = new Map<string, Promise<PiRuntime>>();
  private initializationTail: Promise<void> = Promise.resolve();
  private sweep: ReturnType<typeof setInterval>;

  constructor(
    readonly store: Store,
    private readonly options: PiSessionsOptions = {},
  ) {
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.ownershipDir = resolve(
      options.ownershipDir ?? join(store.root, "leases"),
    );
    for (const session of store.sessions.values()) {
      if (
        !session.file?.startsWith(`${store.sessionsDir}/`) ||
        !existsSync(session.file)
      )
        continue;
      const folder = this.sessionDirectory(session.cwd);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const link = join(folder, basename(session.file));
      if (!existsSync(link)) symlinkSync(session.file, link);
    }
    void Promise.all([...store.sessions.values()].map(async (session) => {
      if (session.hasMessages !== undefined) return;
      try {
        const metadata = session.file ? await sessionMetadata(session.file) : undefined;
        if (store.sessions.get(session.id) === session)
          session.hasMessages = metadata?.hasMessages ?? false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.error("Could not read session metadata:", errorMessage(error));
        session.hasMessages = false;
      }
    })).then(() => this.markChanged());
    this.sweep = setInterval(() => {
      for (const runtime of new Set(this.runtimes.values())) {
        if (
          runtime.listeners.size ||
          runtime.state.loading ||
          runtime.state.dialogs.length ||
          (runtime.session && !runtime.session.isIdle) ||
          this.closing.has(runtime.file) ||
          Date.now() - runtime.lastActivity < 120_000
        )
          continue;
        void this.close(runtime);
      }
    }, 30_000);
    this.sweep.unref();
  }

  list(): SessionRow[] {
    return [...this.store.sessions.values()]
      .map((session) => {
        const runtime = this.runtimes.get(session.id);
        return {
          ...session,
          kind: session.kind ?? "web",
          running: Boolean(runtime?.session && !runtime.session.isIdle),
          waiting: Boolean(runtime?.state.dialogs.length),
          connected: Boolean(runtime?.state.connected),
          completion: completionPreview(runtime?.transcript),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  history(): Promise<HistoryRow[]> {
    return listHistory(join(this.agentDir, "sessions"));
  }

  async sessionFile(path: string): Promise<string> {
    const file = canonicalFile(path);
    if (!this.list().some((row) => row.file && sameFile(row.file, file)) &&
        !(await this.history()).some((row) => sameFile(row.path, file)))
      throw new Error("Session not found in the Pi history catalog");
    return file;
  }

  async rename(path: string, name: string): Promise<void> {
    const file = await this.sessionFile(path);
    this.assertNotOwned(file);
    const runtime = this.runtimesByFile.get(file);
    if (runtime) {
      await runtime.command({ type: "set_session_name", name });
      return;
    }
    const claim = claimSessionFile(file, this.ownershipDir, "web");
    try {
      claim.assertOwner();
      SessionManager.open(file).appendSessionInfo(name);
      for (const row of this.store.sessions.values())
        if (row.file && sameFile(row.file, file))
          this.store.save({ ...row, name, updatedAt: Date.now() });
    } finally {
      claim.release();
    }
    this.markChanged();
  }

  async remove(path: string): Promise<void> {
    const file = await this.sessionFile(path);
    this.assertNotOwned(file);
    const runtime = this.runtimesByFile.get(file);
    if (runtime) await this.close(runtime);
    this.assertNotOwned(file);
    const claim = claimSessionFile(file, this.ownershipDir, "web");
    try {
      claim.assertOwner();
      const trash = join(this.store.root, "trash");
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      const ids = this.list().filter((row) => row.file && sameFile(row.file, file)).map((row) => row.id);
      renameSync(file, join(trash, `${randomUUID()}.jsonl`));
      for (const id of ids) this.store.remove(id);
    } finally {
      claim.release();
    }
    this.markChanged();
  }

  private sessionDirectory(cwd: string) {
    const custom =
      process.env.PI_CODING_AGENT_SESSION_DIR ??
      SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (custom)
      return resolve(
        cwd,
        custom.startsWith("~/")
          ? join(process.env.HOME || "", custom.slice(2))
          : custom,
      );
    return join(
      this.agentDir,
      "sessions",
      `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    );
  }

  async create(cwd: string, source?: string): Promise<Session> {
    let original: { file: string; name: string } | undefined;
    if (source) original = await this.copySource(source);

    const sessionId = randomUUID();
    const workingDirectory = directory(cwd);
    const manager = original
      ? SessionManager.forkFrom(
          original.file,
          workingDirectory,
          this.sessionDirectory(workingDirectory),
          {
            id: sessionId,
          },
        )
      : SessionManager.create(
          workingDirectory,
          this.sessionDirectory(workingDirectory),
          {
            id: sessionId,
          },
        );
    const file = manager.getSessionFile();
    if (!file) throw new Error("Pi did not assign a session file");
    const key = canonicalFile(file);
    this.assertNotOwned(key);
    const claim = claimSessionFile(key, this.ownershipDir, "web");
    try {
      claim.assertOwner();
      const session: Session = {
        id: manager.getSessionId(),
        kind: "web",
        cwd: manager.getCwd(),
        source: original?.file,
        name: original?.name ?? "New session",
        updatedAt: Date.now(),
        file: key,
      };
      this.store.save(session);
      this.registerRuntime(session, manager, claim);
      return session;
    } catch (error) {
      claim.release();
      throw error;
    }
  }

  async resume(path: string): Promise<Session> {
    const rows = await this.history();
    const row = rows.find((candidate) => sameFile(candidate.path, path));
    if (!row) throw new Error("Session not found in the Pi history catalog");
    const file = canonicalFile(row.path);

    const closing = this.closing.get(file);
    if (closing) await closing;

    this.assertNotOwned(file);
    let current = this.runtimesByFile.get(file);
    if (current?.ownsFile) return current.state.session;
    if (current) await this.close(current);
    current = this.runtimesByFile.get(file);
    if (current?.ownsFile) return current.state.session;
    if (current)
      throw new Error("Pi runtime for this session is still closing");

    // Ownership and map registration stay synchronous after catalog validation.
    this.assertNotOwned(file);
    const claim = claimSessionFile(file, this.ownershipDir, "web");
    try {
      claim.assertOwner();
      const manager = SessionManager.open(file);
      const existingByFile = [...this.store.sessions.values()].find(
        (session) => session.file && sameFile(session.file, file),
      );
      const managerId = manager.getSessionId();
      const collision = this.store.sessions.get(managerId);
      const id =
        existingByFile?.id ??
        (collision && !sameFile(collision.file ?? "", file)
          ? randomUUID()
          : managerId);
      const session: Session = {
        ...existingByFile,
        id,
        kind: "web",
        cwd: manager.getCwd(),
        name: manager.getSessionName() ?? existingByFile?.name ?? row.name,
        updatedAt: Math.max(existingByFile?.updatedAt ?? 0, row.updatedAt),
        file,
      };
      this.store.save(session);
      this.registerRuntime(session, manager, claim);
      return session;
    } catch (error) {
      claim.release();
      throw error;
    }
  }

  async open(id: string): Promise<PiRuntime> {
    const session = this.store.get(id);
    const file = session.file ? canonicalFile(session.file) : undefined;
    const closing = file ? this.closing.get(file) : undefined;
    if (closing) await closing;

    const byId = this.runtimes.get(id);
    if (byId && (byId.ownsFile || byId.state.error)) {
      byId.lastActivity = Date.now();
      return byId;
    }
    while (file) {
      const active = this.runtimesByFile.get(file);
      if (!active) break;
      if (active.ownsFile) {
        this.runtimes.set(id, active);
        active.lastActivity = Date.now();
        return active;
      }
      await this.close(active);
    }

    if (file) this.assertNotOwned(file);

    let manager: SessionManager;
    if (file && existsSync(file)) {
      const claim = claimSessionFile(file, this.ownershipDir, "web");
      try {
        claim.assertOwner();
        manager = SessionManager.open(file);
        const updated = {
          ...session,
          cwd: manager.getCwd(),
          name: manager.getSessionName() ?? session.name,
          file,
        };
        this.store.save(updated);
        return this.registerRuntime(updated, manager, claim);
      } catch (error) {
        claim.release();
        throw error;
      }
    }

    manager = session.source
      ? SessionManager.forkFrom(
          session.source,
          session.cwd,
          this.sessionDirectory(session.cwd),
          { id: session.id },
        )
      : SessionManager.create(session.cwd, this.sessionDirectory(session.cwd), {
          id: session.id,
        });
    const newFile = manager.getSessionFile();
    if (!newFile) throw new Error("Pi did not assign a session file");
    const newKey = canonicalFile(newFile);
    this.assertNotOwned(newKey);
    const claim = claimSessionFile(newKey, this.ownershipDir, "web");
    try {
      claim.assertOwner();
      const updated: Session = {
        ...session,
        cwd: manager.getCwd(),
        name: manager.getSessionName() ?? session.name,
        file: newKey,
      };
      this.store.save(updated);
      return this.registerRuntime(updated, manager, claim);
    } catch (error) {
      claim.release();
      throw error;
    }
  }

  async restart(id: string): Promise<PiRuntime> {
    const existing = this.restarting.get(id);
    if (existing) return existing;
    const operation = this.restartSession(id);
    this.restarting.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.restarting.get(id) === operation) this.restarting.delete(id);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.sweep);
    await Promise.all(
      [...new Set(this.runtimes.values())].map((runtime) =>
        this.close(runtime),
      ),
    );
  }

  owns(file: string): boolean {
    let key: string;
    try {
      key = canonicalFile(file);
    } catch {
      key = resolve(file);
    }
    return Boolean(this.runtimesByFile.get(key)?.ownsFile);
  }

  assertNotOwned(file: string): void {
    const key = canonicalFile(file);
    if (this.options.isOwned?.(key))
      throw new Error(
        "This session is owned by the CLI. Close it before opening it in Pi Web UI.",
      );
  }

  async fork(runtime: PiRuntime, entryId: string, position?: "before" | "at") {
    const current = runtime.runtimeResult;
    if (!current) throw new Error("Pi session is not initialized");
    let forked: PiRuntime | undefined;
    const host = new AgentSessionRuntime(
      current.session,
      current.services,
      async (options) => {
        const manager = options.sessionManager;
        const file = manager.getSessionFile();
        if (!file) throw new Error("Pi did not assign a fork session file");
        const key = canonicalFile(file);
        this.assertNotOwned(key);
        const claim = claimSessionFile(key, this.ownershipDir, "web");
        try {
          const session: Session = {
            id: manager.getSessionId(),
            kind: "web",
            cwd: manager.getCwd(),
            name: manager.getSessionName() ?? runtime.state.session.name,
            source: runtime.file,
            updatedAt: Date.now(),
            file: key,
          };
          this.store.save(session);
          forked = this.registerRuntime(
            session,
            manager,
            claim,
            options.sessionStartEvent,
          );
          await forked.ready;
          if (forked.state.error || !forked.runtimeResult)
            throw new Error(forked.state.error ?? "Fork initialization failed");
          return forked.runtimeResult;
        } catch (error) {
          claim.release();
          throw error;
        }
      },
    );
    host.setBeforeSessionInvalidate(() => {
      runtime.detachForReplacement();
      this.unregisterRuntime(runtime);
      this.markChanged();
    });
    const result = await host.fork(entryId, { position });
    return {
      cancelled: result.cancelled,
      session: forked?.state.session,
      text: result.selectedText,
      editorText: result.selectedText,
    };
  }

  async initializeRuntime(
    runtime: PiRuntime,
    sessionStartEvent?: SessionStartEvent,
  ): Promise<void> {
    const initialize = async () => {
      runtime.assertCanInitialize();
      const cwd = runtime.sessionManager.getCwd();
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.agentDir,
        resourceLoaderOptions: {
          extensionFactories: [
            createCodemodeExtension(),
            createMcpExtension(),
            createToolSearchExtension(),
            ...(this.options.extensionFactories ?? []),
          ],
        },
      });
      runtime.assertCanInitialize();
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: runtime.sessionManager,
        sessionStartEvent,
      });
      const { session, modelFallbackMessage } = result;
      const { resourceLoader, settingsManager } = services;
      runtime.runtimeResult = {
        ...result,
        services,
        diagnostics: services.diagnostics,
      };
      const selectedTheme =
        resourceLoader
          .getThemes()
          .themes.find((theme) => theme.name === settingsManager.getTheme()) ??
        noColorTheme;
      runtime.attachSession(session, selectedTheme);
      runtime.assertCanInitialize();
      await session.bindExtensions({
        mode: "rpc",
        uiContext: runtime.getUIContext(),
        onError: ({ error, extensionPath, event }) =>
          runtime.extensionError(error, extensionPath, event),
      });
      runtime.assertCanInitialize();
      runtime.finishInitialization(modelFallbackMessage);
    };

    const task = this.initializationTail.then(initialize, initialize);
    this.initializationTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  markChanged(): void {
    try {
      this.onChange();
    } catch {
      // Catalog observers must not interrupt a Pi session.
    }
  }

  private async copySource(
    source: string,
  ): Promise<{ file: string; name: string }> {
    const history = await this.history();
    const catalogEntry = history.find((entry) => sameFile(entry.path, source));
    const storedEntry = [...this.store.sessions.values()].find(
      (session) => session.file && sameFile(session.file, source),
    );
    const selected = catalogEntry?.path ?? storedEntry?.file;
    if (!selected) throw new Error("Source session not found");
    return {
      file: canonicalFile(selected),
      name: storedEntry?.name ?? catalogEntry?.name ?? "New session",
    };
  }

  private registerRuntime(
    session: Session,
    manager: SessionManager,
    claim: SessionClaim,
    sessionStartEvent?: SessionStartEvent,
  ): PiRuntime {
    const key = canonicalFile(manager.getSessionFile() ?? claim.file);
    if (this.runtimesByFile.has(key)) {
      claim.release();
      throw new Error("A Pi runtime for this session file is already open");
    }
    session.hasMessages = manager.getEntries().some((entry) =>
      entry.type === "message" && entry.message.role === "user");
    const runtime = new PiRuntime(
      this,
      session,
      manager,
      claim,
      sessionStartEvent,
    );
    this.runtimes.set(session.id, runtime);
    this.runtimesByFile.set(key, runtime);
    this.markChanged();
    return runtime;
  }

  private async restartSession(id: string): Promise<PiRuntime> {
    const runtime = this.runtimes.get(id);
    if (runtime?.state.loading) await runtime.ready;
    if (runtime?.session && !runtime.session.isIdle)
      throw new Error("Stop the run before reconnecting Pi");
    if (runtime) await this.close(runtime);
    return this.open(id);
  }

  private unregisterRuntime(runtime: PiRuntime): void {
    for (const [id, current] of this.runtimes) {
      if (current === runtime) this.runtimes.delete(id);
    }
    if (this.runtimesByFile.get(runtime.file) === runtime)
      this.runtimesByFile.delete(runtime.file);
  }

  private close(runtime: PiRuntime): Promise<void> {
    const existing = this.closing.get(runtime.file);
    if (existing) return existing;
    const closing = runtime.stop().finally(() => {
      this.unregisterRuntime(runtime);
      this.closing.delete(runtime.file);
      this.markChanged();
    });
    this.closing.set(runtime.file, closing);
    return closing;
  }
}
