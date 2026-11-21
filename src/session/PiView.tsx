import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import {
  ArrowDown,
  ChevronDown,
  FolderOpen,
  Gauge,
  GitGraph,
  MoreHorizontal,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Search,
  Quote,
} from "lucide-react";
import type { PendingSelection, PiSnapshot, PiUpdate, Session } from "../../shared/types";
import { messageText, reconcileSnapshot } from "../../shared/transcript";
import { applyDisplayEvent } from "../../shared/display";
import { api, basename, useStream } from "../lib/api";
import { Composer } from "./Composer";
import { SessionHistory } from "./SessionHistory";
import { ResizableSplit } from "../components/ResizableSplit";
import { GitBranchMenu } from "./GitBranchMenu";
import { formatAsQuote } from "./composer-text";
import type { SendShortcut } from "../lib/preferences";
import type { GitStatus } from "../../shared/git";
import { ErrorNotice, IconButton, Modal } from "../components/ui";
import { ContextRing } from "./ContextRing";
import { ExtensionDialog } from "./ExtensionDialog";
import { NoticeToast } from "./NoticeToast";
import "./terminal.css";

const Transcript = lazy(() =>
  import("./Transcript").then((module) => ({ default: module.Transcript })),
);
const FilesView = lazy(() =>
  import("../files/FilesView").then((module) => ({ default: module.FilesView })),
);
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
export function PiView({
  session,
  onToggle,
  onCopy,
  onSource,
  onResume,
  onSession,
  sendShortcut,
  wrapLines = false,
}: {
  session: Session;
  sendShortcut: SendShortcut;
  wrapLines?: boolean;
  onToggle: () => void;
  onCopy: () => Promise<void>;
  onSource?: () => void;
  onResume?: () => void;
  onSession: (session: Session) => void;
}) {
  const [data, setData] = useState<PiSnapshot>();
  const [view, setView] = useState("chat");
  const [git, setGit] = useState<GitStatus>();
  const [filesOpened, setFilesOpened] = useState(false);
  const [filesPane, setFilesPane] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitGeneration, setGitGeneration] = useState(0);
  const [filesBranchGeneration, setFilesBranchGeneration] = useState(0);
  const [filesBusy, setFilesBusy] = useState(false);
  const [gitBranchBusy, setGitBranchBusy] = useState(false);
  const sessionGitRoot = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setGitError("");
    void api<GitStatus>(`/git?${new URLSearchParams({ cwd: session.cwd })}`)
      .then((status) => {
        if (active) {
          sessionGitRoot.current = status.isRepo ? status.root : undefined;
          setGit(status);
        }
      })
      .catch((error) => {
        if (active) setGitError(error.message);
      });
    return () => {
      active = false;
    };
  }, [session.cwd, gitGeneration]);
  const updateGit = useCallback((status: GitStatus) => {
    if (status.isRepo && status.root === sessionGitRoot.current) {
      setGit(status);
      setGitError("");
    }
  }, []);
  const [modelPicker, setModelPicker] = useState(false);
  const [thinkingChange, setThinkingChange] = useState<string>();
  const [modelQuery, setModelQuery] = useState("");
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(session.name);
  const [error, setError] = useState("");
  const [queueMode, setQueueMode] = useState("steer");
  const [restoreRequest, setRestoreRequest] = useState<{ id: string; from: PendingSelection }>();
  const [composerBusy, setComposerBusy] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [dropped, setDropped] = useState<{ id: string; files: File[]; containsDirectory: boolean }>();
  const [prefill, setPrefill] = useState<{ id: string; text: string; append?: boolean }>();
  const [selectedText, setSelectedText] = useState("");
  const [generation, setGeneration] = useState(0);
  const [branching, setBranching] = useState(false);
  const branchInFlight = useRef(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  const ownScroll = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [activeTurn, setActiveTurn] = useState(0);
  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const answer = anchor?.parentElement?.closest(".answer");
      setSelectedText(
        answer && scroll.current?.contains(answer) && selection?.focusNode && answer.contains(selection.focusNode)
          ? selection.toString().trim()
          : "",
      );
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, []);
  const latestData = useRef<PiSnapshot | undefined>(undefined);
  const streamPrefill = useRef<{ id: string; text: string } | undefined>(undefined);
  const showLatest = useCallback(() => {
    if (document.hidden) return;
    setData(latestData.current);
    if (streamPrefill.current) {
      setPrefill(streamPrefill.current);
      streamPrefill.current = undefined;
    }
  }, []);
  useEffect(() => {
    document.addEventListener("visibilitychange", showLatest);
    return () => document.removeEventListener("visibilitychange", showLatest);
  }, [showLatest]);
  const connected = useStream<PiUpdate>(
    `/pi/${encodeURIComponent(session.id)}/stream?v=${generation}`,
    (updates) => {
      let current = latestData.current;
      for (const update of updates) {
        if (update.kind === "snapshot") current = reconcileSnapshot(current, update.value);
        else if (update.kind === "state") {
          if (current) current = { ...current, state: update.value };
        } else {
          if (current) {
            const transcript = applyDisplayEvent(current.transcript, update.value);
            if (transcript !== current.transcript) current = { ...current, transcript };
          }
          if (update.value.type === "extension_ui_request" && update.value.method === "set_editor_text")
            streamPrefill.current = { id: update.value.id, text: update.value.text };
        }
      }
      latestData.current = current;
      showLatest();
    },
    setError,
    { batchMs: 50 },
  );
  const state = data?.state;
  const projection = data?.transcript;
  const online = connected && state?.connected !== false;
  const native = (state?.owner ?? session.kind) === "cli";
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  useEffect(() => {
    if (!connected || !native || state?.connected !== false || !session.file) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const attach = async () => {
      try {
        const resumed = await api<Session>("/pi/attach", { path: session.file });
        if (disposed) return;
        if (resumed.kind === "web") {
          onSessionRef.current(resumed);
          return;
        }
        timer = setTimeout(attach, 1000);
      } catch (error) {
        if (!disposed) setError((error as Error).message);
      }
    };
    void attach();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connected, native, state?.connected, session.file]);
  const loadedTurns = useMemo(
    () =>
      (projection?.items ?? [])
        .filter((item) => item.message.role === "user")
        .map((item) => {
          const line = messageText(item.message).split("\n")[0]?.trim() || "";
          return line.length > 64 ? `${line.slice(0, 64)}…` : line;
        }),
    [projection?.items],
  );
  const empty = !projection?.items.length && !projection?.partial && !projection?.running;
  const showIntro = empty && view === "chat";
  useEffect(() => {
    follow.current = true;
    const observer = new ResizeObserver(() => {
      const element = scroll.current;
      if (!element || view !== "chat") return;
      if (follow.current) {
        const nextTop = Math.max(0, element.scrollHeight - element.clientHeight);
        if (Math.abs(element.scrollTop - nextTop) > 1) {
          ownScroll.current = nextTop;
          element.scrollTop = nextTop;
          lastScrollTop.current = nextTop;
        }
      }
      setAtBottom(
        element.scrollHeight - element.scrollTop - element.clientHeight < 90,
      );
    });
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setFilesOpened(true);
        setFilesPane((open) => (view === "files" ? true : !open));
        if (view === "files") setView("chat");
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "`") {
        event.preventDefault();
        setTerminalOpened(true);
        setTerminalOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [view]);
  useEffect(() => {
    document.title = `${state?.session.name || session.name} · pi`;
  }, [state?.session.name, session.name]);
  const command = <T = unknown,>(body: object): Promise<T> =>
    api<T>(`/pi/${encodeURIComponent(session.id)}/command`, body);
  const act = async (body: object) => {
    setError("");
    try {
      await command(body);
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  };
  const branchDisabled = !online
    ? "Session is not connected"
    : state?.loading
      ? "Session is loading"
      : native && !state?.capabilities?.treeNavigation
        ? "Run /reload in this CLI to load branch controls"
        : branching
          ? "Session navigation is in progress"
          : projection?.running
            ? "Stop or wait for the current run before navigating"
            : composerBusy
              ? "Wait for the composer to finish"
              : undefined;
  const canBranch = !branchDisabled;
  const branch = async (
    entryId: string,
    action: "fork" | "navigate_tree",
    position: "before" | "at" = "before",
  ) => {
    if (!canBranch || branchInFlight.current) return;
    branchInFlight.current = true;
    setBranching(true);
    setError("");
    try {
      const result = await command<{
        cancelled?: boolean;
        session?: Session;
        text?: string;
        editorText?: string;
      }>({
        type: action,
        ...(action === "fork" ? { entryId, position } : { targetId: entryId }),
      });
      if (result.cancelled) {
        setError("Navigation was cancelled by a pi extension");
        return;
      }
      const text = result.editorText ?? result.text;
      const previousDraft = sessionStorage.getItem(`draft:${session.id}`) || "";
      if (result.session && result.session.id !== session.id) {
        if (text) sessionStorage.setItem(`draft:${result.session.id}`, text);
        onSession(result.session);
      } else if (text)
        setPrefill({
          id: crypto.randomUUID(),
          text:
            text === previousDraft
              ? text
              : [text, previousDraft]
                  .filter((value) => value.trim())
                  .join("\n\n"),
        });
      setTreeOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      branchInFlight.current = false;
      setBranching(false);
    }
  };
  const restorePending = useCallback((from: PendingSelection) => {
    setRestoreRequest({ id: crypto.randomUUID(), from });
  }, []);
  const branchRef = useRef(branch);
  branchRef.current = branch;
  const onBranch = useCallback((...args: Parameters<typeof branch>) => {
    void branchRef.current(...args);
  }, []);
  const showTree = () => {
    setError("");
    setTreeOpen(true);
  };
  const stats = state?.stats;
  const turns = useMemo(() => stats?.userMessages ??
    projection?.items.filter((item) => item.message.role === "user").length,
    [stats?.userMessages, projection?.items]);
  const calls = useMemo(() => stats?.toolCalls ??
    projection?.items.reduce(
      (count, { message }) =>
        count +
        (message.role === "assistant"
          ? message.content.filter((block) => block.type === "toolCall").length
          : 0),
      0,
    ), [stats?.toolCalls, projection?.items]);
  const contextUsage = stats?.contextUsage ?? state?.contextUsage;
  const statuses = Object.values(state?.statuses || {})
    .filter(Boolean)
    .join(" · ");
  const modelControls = (
    <>
      {projection?.running && (
        <select
          aria-label="Queue behavior"
          value={queueMode}
          onChange={(event) => setQueueMode(event.target.value)}
        >
          <option value="steer">Steer</option>
          <option value="followUp">Follow-up</option>
        </select>
      )}
      <span className="toolbar-spacer" />
      <button
        className="model-button"
        type="button"
        disabled={!state || state.loading || !online || Boolean(state.error)}
        onClick={() => setModelPicker(true)}
      >
        {state?.model?.name ||
          (state?.loading ? "Loading models…" : "Select model")}
        <ChevronDown size={15} />
      </button>
      {state && state.levels.length > 1 && (
        <select
          className="thinking-select"
          aria-label="Thinking level"
          value={thinkingChange ?? state.thinkingLevel}
          title={projection?.running ? "Applies to the next model request" : "Reasoning effort"}
          disabled={!online || state.loading || Boolean(state.error) || thinkingChange !== undefined}
          onChange={(event) => {
            const level = event.target.value;
            setThinkingChange(level);
            void act({ type: "set_thinking_level", level }).finally(() => setThinkingChange(undefined));
          }}
        >
          {state.levels.map((level) => (
            <option key={level}>{level}</option>
          ))}
        </select>
      )}
    </>
  );
  const composer = (
    <Composer
      id={session.id}
      cwd={session.cwd}
      sendShortcut={sendShortcut}
      commands={[
        { name: "compact", description: "Compact context" },
        ...(state?.commands || []),
      ]}
      prefill={prefill}
      dropped={dropped}
      draggingFiles={draggingFiles}
      restoreRequest={restoreRequest}
      onBusyChange={setComposerBusy}
      disabled={
        !online || !state || state.loading || branching || Boolean(state.error)
      }
      running={projection?.running}
      toolbar={modelControls}
      placeholder={
        empty ? "Describe what you want to build, / commands" : undefined
      }
      onSend={async (message) => {
        follow.current = true;
        if (scroll.current) {
          const nextTop = Math.max(0, scroll.current.scrollHeight - scroll.current.clientHeight);
          ownScroll.current = nextTop;
          scroll.current.scrollTop = nextTop;
          lastScrollTop.current = nextTop;
          setAtBottom(true);
        }
        if (message.trim() === "/compact")
          await command({ type: "compact" });
        else
          await command({
            type: "prompt",
            message,
            ...(projection?.running ? { streamingBehavior: queueMode } : {}),
          });
      }}
      onStop={async () => {
        await command({ type: "abort" });
      }}
      onRestorePending={async (from) => {
        if (native && !state?.capabilities?.queueRecovery)
          throw new Error(
            state?.capabilities?.queueRecoveryReason ||
              "This Pi CLI does not expose pending messages or queue recovery to extensions.",
          );
        const recovered = await command<{
          steering: string[];
          followUp: string[];
        }>({ type: "clear_queue", ...(from ? { from } : {}) });
        return [...recovered.steering, ...recovered.followUp];
      }}
    />
  );

  return (
    <div className="session-view">
      <header className="session-header">
        <IconButton label="Toggle sidebar" onClick={onToggle}>
          <PanelLeft size={19} />
        </IconButton>
        <h1>{(state?.session.name || session.name).split("\n")[0]}</h1>
        <span className={`connection ${online ? "" : "offline"}`}>
          {!online
            ? connected && native
              ? "CLI not connected"
              : "Reconnecting"
            : state?.loading
              ? "Starting pi"
              : projection?.running
                ? "Running"
                : native
                  ? "CLI"
                  : "pi"}
        </span>
        {git?.isRepo && (
          <GitBranchMenu
            status={git}
            disabled={filesBusy}
            onBusyChange={setGitBranchBusy}
            onRefresh={() => setGitGeneration((value) => value + 1)}
            onChange={(status) => {
              updateGit(status);
              setGitGeneration((value) => value + 1);
              setFilesBranchGeneration((value) => value + 1);
            }}
          />
        )}
        <div className="header-actions">
          <div className="pane-toggles">
            <button
              className="open-workspace-button"
              aria-label="Open workspace folder"
              title={`Open ${basename(session.cwd)} in file manager`}
              onClick={() => {
                const encoded = session.cwd.split("/").map(encodeURIComponent).join("/");
                const url = session.cwd.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
                void api("/files/open", { url }).catch((reason) =>
                  setError((reason as Error).message),
                );
              }}
            >
              <FolderOpen size={17} />
            </button>
            <button
              className="terminal-toggle"
              aria-label="Toggle terminal"
              aria-pressed={terminalOpen}
              title="Toggle terminal (⌃`)"
              onClick={() => {
                setTerminalOpened(true);
                setTerminalOpen(!terminalOpen);
              }}
            >
              <PanelBottom size={18} />
            </button>
            <button
              className="files-toggle"
              aria-label="Toggle files pane"
              aria-pressed={filesPane && view !== "files"}
              title="Toggle files pane (⇧⌘B)"
              onClick={() => {
                setFilesOpened(true);
                setFilesPane(view === "files" || !filesPane);
                if (view === "files") setView("chat");
              }}
            >
              <PanelRight size={18} />
            </button>
          </div>
          <details
            className="session-menu"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                event.currentTarget.open = false;
            }}
          >
            <summary aria-label="Session actions">
              <MoreHorizontal size={20} />
            </summary>
            <div className="menu">
              {onResume && !online && (
                <button onClick={onResume}>Resume in Web…</button>
              )}
              {onSource && (
                <button onClick={onSource}>View original session</button>
              )}
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(session.cwd).catch(() => {});
                }}
              >
                Copy workspace path
              </button>
              <button
                disabled={!session.file}
                onClick={() => {
                  if (!session.file) return;
                  const params = new URLSearchParams({ path: session.file, format: "md" });
                  location.assign(`/api/pi/export?${params}`);
                }}
              >
                Download Markdown
              </button>
              <button
                disabled={!session.file}
                onClick={() => {
                  if (!session.file) return;
                  const params = new URLSearchParams({ path: session.file, format: "jsonl" });
                  location.assign(`/api/pi/export?${params}`);
                }}
              >
                Download JSONL
              </button>
              <button
                disabled={!session.file || state?.loading}
                onClick={async () => {
                  try {
                    await onCopy();
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Copy session
              </button>
              <button
                onClick={() => {
                  setName(state?.session.name || session.name);
                  setRename(true);
                }}
              >
                Rename session
              </button>
              <button
                disabled={!online || state?.loading}
                onClick={() => void act({ type: "compact" })}
              >
                Compact context
              </button>
              <button
                disabled={projection?.running}
                onClick={async () => {
                  try {
                    await api(
                      `/pi/${encodeURIComponent(session.id)}/restart`,
                      {},
                    );
                    setGeneration(generation + 1);
                    setError("");
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Reconnect pi
              </button>
            </div>
          </details>
        </div>
      </header>
      <nav className="view-tabs" aria-label="Conversation view">
        {["chat", "raw", "files"].map((tab) => (
          <button
            key={tab}
            aria-current={view === tab ? "page" : undefined}
            onClick={() => {
              if (tab === "files") setFilesOpened(true);
              setView(tab);
            }}
          >
            {tab === "chat" ? "Chat" : tab === "files" ? "Files" : "Raw"}
          </button>
        ))}
        <button className="history-trigger" disabled={!online || state?.loading || Boolean(state?.error)} onClick={showTree}>
          <GitGraph size={16} /> History
        </button>
      </nav>
      {gitError && (
        <button
          className="notice"
          title={gitError}
          onClick={() => setGitGeneration((value) => value + 1)}
        >
          Git status unavailable · Retry
        </button>
      )}
      <ErrorNotice error={error || state?.error} />
      <ResizableSplit
        direction="vertical"
        resizeSecond
        initialSize={260}
        minSize={100}
        minRemaining={filesPane && view !== "files" ? 400 : 260}
        label="Resize terminal"
        secondHidden={!terminalOpen}
        first={
          <ResizableSplit
            resizeSecond
            initialSize={520}
            minSize={320}
            minRemaining={340}
            stackAt={660}
            label="Resize files pane"
            firstHidden={view === "files"}
            secondHidden={view !== "files" && !filesPane}
            first={
              <div
                className={`conversation-body ${showIntro ? "is-empty" : ""} ${draggingFiles ? "is-file-dragging" : ""}`}
                onDragEnter={(event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDraggingFiles(true);
                  }
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDraggingFiles(true);
                    event.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setDraggingFiles(false);
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  setDraggingFiles(false);
                  setDropped({
                    id: crypto.randomUUID(),
                    files: Array.from(event.dataTransfer.files),
                    containsDirectory: Array.from(event.dataTransfer.items).some(
                      (item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
                    ),
                  });
                }}
              >
                <div className="empty-intro" hidden={!showIntro}>
                  <div className="hero-title">
                    <img className="pi-mark" src="/favicon.svg" alt="" width={36} height={36} />
                    <h2>New session</h2>
                  </div>
                  <div className="workspace-context" title={session.cwd}>
                    <FolderOpen size={18} />
                    {basename(session.cwd)}
                  </div>
                </div>
                <div
                  className={`transcript-scroll ${view}`}
                  hidden={showIntro || view === "files"}
                  ref={scroll}
                  onWheel={(event) => {
                    if (event.deltaY < 0) follow.current = false;
                  }}
                  onTouchStart={(event) => {
                    touchY.current = event.touches[0]?.clientY ?? null;
                  }}
                  onTouchMove={(event) => {
                    const y = event.touches[0]?.clientY;
                    if (y !== undefined && touchY.current !== null && y - touchY.current > 4)
                      follow.current = false;
                  }}
                  onTouchEnd={() => {
                    touchY.current = null;
                  }}
                  onClick={(event) => {
                    if ((event.target as Element).closest("summary, .load-older"))
                      follow.current = false;
                  }}
                  onScroll={() => {
                    const element = scroll.current!;
                    const distance =
                      element.scrollHeight - element.scrollTop - element.clientHeight;
                    const isOwn =
                      ownScroll.current !== null &&
                      Math.abs(element.scrollTop - ownScroll.current) <= 2;
                    ownScroll.current = null;
                    if (!isOwn) {
                      if (element.scrollTop < lastScrollTop.current - 1) {
                        follow.current = false;
                      } else if (distance <= 20) {
                        follow.current = true;
                      }
                    }
                    lastScrollTop.current = element.scrollTop;
                    setAtBottom(distance < 90);
                    const turnElements = element.querySelectorAll<HTMLElement>(".turn");
                    if (turnElements.length > 1) {
                      const mid = element.getBoundingClientRect().top + element.clientHeight * 0.35;
                      let current = 0;
                      for (let i = 0; i < turnElements.length; i++) {
                        if (turnElements[i].getBoundingClientRect().top <= mid) current = i;
                        else break;
                      }
                      setActiveTurn(current);
                    }
                  }}
                >
                  <div ref={content}>
                    <Suspense
                      fallback={<p className="empty-note">Loading conversation…</p>}
                    >
                      {!showIntro && projection && (
                        <Transcript
                          key={`${session.id}:${generation}:${branching}`}
                          sessionId={session.id}
                          cwd={session.cwd}
                          projection={projection}
                          raw={view === "raw"}
                          onBranch={onBranch}
                          branchDisabled={branchDisabled}
                          onRestorePending={state?.capabilities?.queueRecovery
                            ? restorePending
                            : undefined}
                          restoreDisabled={!online || !state || state.loading || branching || Boolean(state.error) || composerBusy}
                        />
                      )}
                    </Suspense>
                  </div>
                </div>
                {!showIntro && view === "chat" && loadedTurns.length > 1 && (
                  <nav className="turn-scrubber" aria-label="Turn navigation">
                    {Array.from({ length: Math.min(loadedTurns.length, 40) }, (_, index) => {
                      const total = loadedTurns.length;
                      const targetIndex = total <= 40 ? index : Math.round((index * (total - 1)) / 39);
                      const isActive = total <= 40
                        ? activeTurn === index
                        : Math.round((activeTurn * 39) / Math.max(1, total - 1)) === index;
                      const preview = loadedTurns[targetIndex];
                      return (
                        <button
                          key={index}
                          type="button"
                          className={isActive ? "active" : undefined}
                          aria-label={`Jump to turn ${targetIndex + 1}`}
                          title={preview ? `${targetIndex + 1}. ${preview}` : `Turn ${targetIndex + 1}`}
                          onClick={() => {
                            const turnEl = scroll.current?.querySelectorAll<HTMLElement>(".turn")[targetIndex];
                            if (turnEl) {
                              follow.current = false;
                              turnEl.scrollIntoView({ behavior: "smooth", block: "start" });
                              setActiveTurn(targetIndex);
                            }
                          }}
                        />
                      );
                    })}
                  </nav>
                )}
                <div className="composer-dock" hidden={view === "files"}>
                  {!empty && !atBottom && view === "chat" && (
                    <button
                      className="jump-bottom"
                      aria-label="Jump to latest"
                      onClick={() => {
                        follow.current = true;
                        scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
                        setAtBottom(true);
                      }}
                    >
                      <ArrowDown size={20} />
                    </button>
                  )}
                  {selectedText && view === "chat" && (
                    <button
                      className="insert-quote"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setPrefill({ id: crypto.randomUUID(), text: formatAsQuote(selectedText), append: true });
                        window.getSelection()?.removeAllRanges();
                        setSelectedText("");
                      }}
                    >
                      <Quote size={15} /> Insert quote
                    </button>
                  )}
                  {composer}
                  <footer className="session-footer" hidden={empty && !statuses}>
                    <div className="session-stats" hidden={empty}>
                      {turns !== undefined && (
                        <span>
                          <Gauge size={14} />
                          {turns} {turns === 1 ? "turn" : "turns"} · {calls} {calls === 1 ? "call" : "calls"}
                        </span>
                      )}
                      {contextUsage && (
                        <span
                          title={`Context: ${contextUsage.tokens === null ? "—" : compactNumber(contextUsage.tokens)} / ${compactNumber(contextUsage.contextWindow)} tok`}
                        >
                          <ContextRing
                            ratio={
                              contextUsage.tokens !== null && contextUsage.contextWindow > 0
                                ? Math.min(1, Math.max(0, contextUsage.tokens / contextUsage.contextWindow))
                                : 0
                            }
                          />
                          {contextUsage.tokens === null
                            ? "—"
                            : `${Math.round((contextUsage.tokens / Math.max(1, contextUsage.contextWindow)) * 100)}%`}
                          <span className="context-detail">
                            ({contextUsage.tokens === null ? "—" : compactNumber(contextUsage.tokens)} / {compactNumber(contextUsage.contextWindow)})
                          </span>
                        </span>
                      )}
                      {Boolean(stats?.cost) && <span>${stats!.cost.toFixed(3)}</span>}
                    </div>
                    {statuses && (
                      <div className="extension-status" title={statuses}>
                        {statuses}
                      </div>
                    )}
                  </footer>
                </div>
              </div>
            }
            second={filesOpened && (
              <div className="git-panel">
                <Suspense fallback={<div className="loading-line">Loading files…</div>}>
                  <FilesView
                    cwd={session.cwd}
                    onStatusChange={updateGit}
                    onBusyChange={setFilesBusy}
                    branchGeneration={filesBranchGeneration}
                    branchBusy={gitBranchBusy}
                    wrap={wrapLines}
                  />
                </Suspense>
              </div>
            )}
          />
        }
        second={terminalOpened && (
          <div className="terminal-dock">
            <Suspense fallback={<div className="loading-line">Loading terminal…</div>}>
              <TerminalPanel sessionId={session.id} cwd={session.cwd} onHide={() => setTerminalOpen(false)} />
            </Suspense>
          </div>
        )}
      />
      {treeOpen && (
        <SessionHistory command={command} onClose={() => setTreeOpen(false)} onBranch={onBranch}
          disabled={branchDisabled} error={error} native={native} liveLeafId={state?.leafId} />
      )}
      {modelPicker && (
        <Modal title="Model" onClose={() => setModelPicker(false)}>
          <label className="search-field">
            <Search size={17} />
            <input
              autoFocus
              aria-label="Search models"
              placeholder="Search models"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
            />
          </label>
          <div className="model-list">
            {state?.models
              .filter((model) =>
                `${model.provider} ${model.name} ${model.id}`
                  .toLowerCase()
                  .includes(modelQuery.toLowerCase()),
              )
              .map((model) => (
                <button
                  key={`${model.provider}/${model.id}`}
                  onClick={async () => {
                    if (
                      await act({
                        type: "set_model",
                        provider: model.provider,
                        modelId: model.id,
                      })
                    )
                      setModelPicker(false);
                  }}
                >
                  <span>{model.name || model.id}</span>
                  <small>
                    {model.provider} · {compactNumber(model.contextWindow)}{" "}
                    context
                  </small>
                  {model.id === state.model?.id &&
                    model.provider === state.model.provider && (
                      <span className="selected-dot" />
                    )}
                </button>
              ))}
            {!state?.models.length && (
              <p className="empty-note">
                No configured models. Authenticate with pi in your terminal.
              </p>
            )}
          </div>
          <ErrorNotice error={error} />
        </Modal>
      )}
      {rename && (
        <Modal title="Rename session" onClose={() => setRename(false)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (await act({ type: "set_session_name", name }))
                setRename(false);
            }}
          >
            <input
              aria-label="Session name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
            />
            <ErrorNotice error={error} />
            <div className="dialog-actions">
              <button className="primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
      {state?.notice && !state.notice.startsWith("RTK rewrite:") && (
        <NoticeToast key={state.notice} message={state.notice} />
      )}
      {state?.dialogs[0] && (
        <ExtensionDialog
          key={state.dialogs[0].id}
          request={state.dialogs[0]}
          respond={(body) =>
            api(`/pi/${encodeURIComponent(session.id)}/respond`, body)
          }
        />
      )}
    </div>
  );
}

const compactNumber = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
