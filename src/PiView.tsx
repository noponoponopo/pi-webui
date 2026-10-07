import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ChevronDown,
  Database,
  FolderOpen,
  Gauge,
  MoreHorizontal,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Search,
  Quote,
} from "lucide-react";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { PendingSelection, PiSnapshot, PiUpdate, Session } from "../shared/types";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageText } from "../shared/transcript";
import { applyEvent } from "../shared/transcript";
import { api, basename, useStream } from "./api";
import { Composer } from "./Composer";
import { ResizableSplit } from "./ResizableSplit";
import { GitBranchMenu } from "./GitBranchMenu";
import { formatAsQuote } from "./composer-text";
import type { SendShortcut } from "./preferences";
import type { GitStatus } from "../shared/git";
import { ErrorNotice, IconButton, Modal } from "./ui";
import "./terminal.css";

const Transcript = lazy(() =>
  import("./Transcript").then((module) => ({ default: module.Transcript })),
);
const FilesView = lazy(() =>
  import("./FilesView").then((module) => ({ default: module.FilesView })),
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
  const [prefill, setPrefill] = useState<{ id: string; text: string; append?: boolean }>();
  const [selectedText, setSelectedText] = useState("");
  const [generation, setGeneration] = useState(0);
  const [branching, setBranching] = useState(false);
  const branchInFlight = useRef(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeEntries, setTreeEntries] = useState<SessionEntry[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  const ownScroll = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
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
  const connected = useStream<PiUpdate>(
    `/pi/${encodeURIComponent(session.id)}/stream?v=${generation}`,
    (update) => {
      if (update.kind === "snapshot") setData(update.value);
      else if (update.kind === "state")
        setData((current) =>
          current ? { ...current, state: update.value } : current,
        );
      else {
        setData((current) =>
          current
            ? {
                ...current,
                transcript: applyEvent(current.transcript, update.value),
              }
            : current,
        );
        if (
          update.value.type === "extension_ui_request" &&
          update.value.method === "set_editor_text"
        )
          setPrefill({ id: update.value.id, text: update.value.text });
      }
    },
    setError,
  );
  const state = data?.state;
  const projection = data?.transcript;
  const online = connected && state?.connected !== false;
  const native = (state?.owner ?? session.kind) === "cli";
  const empty =
    !projection?.items.some((item) => item.message.role === "user") &&
    !projection?.running;
  const showIntro = empty && view === "chat";
  const latestUser = projection?.items.findLast(
    (item) => item.message.role === "user",
  )?.id;
  useEffect(() => {
    let anchor = true;
    follow.current = false;
    const observer = new ResizeObserver(() => {
      const element = scroll.current;
      if (!element || view !== "chat") return;
      let target: number | undefined;
      if (anchor) {
        const user = element.querySelectorAll<HTMLElement>(".user-message");
        const last = user.item(user.length - 1);
        if (!last) return;
        target =
          element.scrollTop +
          last.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          20;
        anchor = false;
      } else if (follow.current) target = element.scrollHeight;
      if (target !== undefined) {
        ownScroll.current = Math.max(
          0,
          Math.min(target, element.scrollHeight - element.clientHeight),
        );
        element.scrollTop = ownScroll.current;
      }
      setAtBottom(
        element.scrollHeight - element.scrollTop - element.clientHeight < 90,
      );
    });
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [view, latestUser]);
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
      if (result.cancelled) return;
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
  const showTree = async () => {
    setError("");
    try {
      const result = await command<{ entries: SessionEntry[] }>({
        type: "get_entries",
      });
      setTreeEntries(result.entries);
      setTreeOpen(true);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const stats = state?.stats;
  const turns =
    stats?.userMessages ??
    projection?.items.filter((item) => item.message.role === "user").length;
  const calls =
    stats?.toolCalls ??
    projection?.items.reduce(
      (count, { message }) =>
        count +
        (message.role === "assistant"
          ? message.content.filter((block) => block.type === "toolCall").length
          : 0),
      0,
    );
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
              disabled={!canBranch}
              title={branchDisabled}
              onClick={() => void showTree()}
            >
              Session history…
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
        <div className="pane-toggles">
          <button
            className="terminal-toggle"
            aria-label="Toggle terminal"
            aria-pressed={terminalOpen}
            title="Toggle terminal"
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
            title="Toggle files pane"
            onClick={() => {
              setFilesOpened(true);
              setFilesPane(view === "files" || !filesPane);
              if (view === "files") setView("chat");
            }}
          >
            <PanelRight size={18} />
          </button>
        </div>
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
      {state?.notice && !state.notice.startsWith("RTK rewrite:") && (
        <div className="notice" role="status">
          {state.notice}
        </div>
      )}
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
              <div className={`conversation-body ${showIntro ? "is-empty" : ""}`}>
                <div className="empty-intro" hidden={!showIntro}>
                  <div className="hero-title">
                    <span className="pi-mark">π</span>
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
                  onClick={(event) => {
                    if ((event.target as Element).closest("summary, .load-older"))
                      follow.current = false;
                  }}
                  onScroll={() => {
                    const element = scroll.current!;
                    const bottom =
                      element.scrollHeight - element.scrollTop - element.clientHeight <
                      90;
                    if (
                      ownScroll.current === null ||
                      Math.abs(element.scrollTop - ownScroll.current) > 1
                    )
                      follow.current = bottom;
                    ownScroll.current = null;
                    setAtBottom(bottom);
                  }}
                >
                  <div ref={content}>
                    <Suspense
                      fallback={<p className="empty-note">Loading conversation…</p>}
                    >
                      {!showIntro && projection && (
                        <Transcript
                          projection={projection}
                          raw={view === "raw"}
                          onBranch={(id, action, position) =>
                            void branch(id, action, position)
                          }
                          branchDisabled={branchDisabled}
                          onRestorePending={state?.capabilities?.queueRecovery
                            ? (from) => setRestoreRequest({ id: crypto.randomUUID(), from })
                            : undefined}
                          restoreDisabled={!online || !state || state.loading || branching || Boolean(state.error) || composerBusy}
                        />
                      )}
                    </Suspense>
                  </div>
                </div>
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
                          {turns} turns · {calls} calls
                        </span>
                      )}
                      {contextUsage && (
                        <span title="Context usage">
                          <Database size={14} />
                          {contextUsage.tokens === null
                            ? "—"
                            : compactNumber(contextUsage.tokens)}{" "}
                          / {compactNumber(contextUsage.contextWindow)} tok
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
        <Modal title="Session history" onClose={() => setTreeOpen(false)}>
          <div className="session-tree-list">
            {treeEntries
              .filter(
                (entry) =>
                  entry.type === "message" &&
                  (entry.message.role === "user" ||
                    entry.message.role === "assistant"),
              )
              .map(
                (entry) =>
                  entry.type === "message" && (
                    <div key={entry.id} className="session-tree-entry">
                      <span className="muted">
                        {entry.message.role} · {entry.id}
                        {entry.id === state?.leafId ? " · current" : ""}
                      </span>
                      <pre>{messageText(entry.message).slice(0, 200)}</pre>
                      <button
                        disabled={!canBranch}
                        onClick={() => void branch(entry.id, "navigate_tree")}
                      >
                        Continue from here
                      </button>
                      <button
                        disabled={!canBranch}
                        onClick={() =>
                          void branch(
                            entry.id,
                            "fork",
                            entry.message.role === "user" ? "before" : "at",
                          )
                        }
                      >
                        Fork
                      </button>
                    </div>
                  ),
              )}
          </div>
        </Modal>
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
function ExtensionDialog({
  request,
  respond,
}: {
  request: RpcExtensionUIRequest;
  respond: (body: object) => Promise<unknown>;
}) {
  const [value, setValue] = useState(
    "prefill" in request ? request.prefill || "" : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await respond({ id: request.id, ...body });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={"title" in request ? request.title : "pi"}
      onClose={() => {
        if (!busy) void send({ cancelled: true });
      }}
    >
      {"message" in request && <p>{request.message}</p>}
      <ErrorNotice error={error} />
      {request.method === "select" ? (
        <div className="choice-list">
          {request.options.map((option) => (
            <button
              key={option}
              disabled={busy}
              onClick={() => void send({ value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ) : request.method === "confirm" ? (
        <div className="dialog-actions">
          <button
            disabled={busy}
            onClick={() => void send({ confirmed: false })}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="primary"
            onClick={() => void send({ confirmed: true })}
          >
            Confirm
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send({ value });
          }}
        >
          <textarea
            aria-label="Response"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={request.method === "editor" ? 8 : 2}
            placeholder={"placeholder" in request ? request.placeholder : ""}
          />
          <div className="dialog-actions">
            <button className="primary" disabled={busy} type="submit">
              Submit
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
