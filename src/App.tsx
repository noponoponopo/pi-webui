import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bookmark,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageCirclePlus,
  PanelLeft,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { HistoryRow, Session, SessionRow } from "../shared/types";
import { age, api, basename, useStream } from "./api";
import { Composer } from "./Composer";
import {
  sendShortcuts,
  storedSendShortcut,
  storedWrapLines,
  type SendShortcut,
} from "./preferences";
import { OpenHistoryDialog } from "./OpenHistoryDialog";
import { Workspace } from "./Workspace";
import { WorkspacePathInput } from "./WorkspacePathInput";
import { ResizeHandle } from "./ResizableSplit";
import { SessionMenu } from "./SessionMenu";
import { sessionKey, storedActivity, storedBookmarks, updateActivity } from "./session-activity";
import {
  workspaceOrder,
  workspaceSessions,
  type WorkspaceSession,
} from "../shared/workspaces";
import { PiView } from "./PiView";
import { ErrorNotice, IconButton, Modal } from "./ui";

function route() {
  const [, , encoded = ""] = location.hash.split("/");
  return {
    id: decodeURIComponent(encoded),
  };
}

export function App() {
  const [locationState, setLocation] = useState(route);
  const { id } = locationState;
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [workspacePositions, setWorkspacePositions] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState(storedBookmarks);
  const [activity, setActivity] = useState(storedActivity);
  useEffect(() => {
    localStorage.setItem('pi-webui-session-bookmarks', JSON.stringify(bookmarks));
  }, [bookmarks]);
  useEffect(() => {
    localStorage.setItem('pi-webui-session-activity', JSON.stringify(activity));
  }, [activity]);
  useEffect(() => {
    const update = () => setActivity((previous) => updateActivity(
      previous, sessions, !document.hidden && document.hasFocus() ? id : '',
    ));
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [sessions, id]);
  const [workspacePins, setWorkspacePins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("pi-webui-workspace-pins") || "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((key) => typeof key === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(
      "pi-webui-workspace-pins",
      JSON.stringify(workspacePins),
    );
  }, [workspacePins]);
  const togglePin = (key: string) =>
    setWorkspacePins((current) =>
      current.includes(key)
        ? current.filter((pin) => pin !== key)
        : [...current, key],
    );
  const pinRank = (key: string) => {
    const index = workspacePins.indexOf(key);
    return index < 0 ? workspacePins.length : index;
  };
  const [historyError, setHistoryError] = useState("");
  const [openingHistory, setOpeningHistory] = useState<HistoryRow>();
  const [opening, setOpening] = useState("");
  const [defaultCwd, setDefaultCwd] = useState("");
  const [error, setError] = useState("");
  const [sidebar, setSidebar] = useState(() => innerWidth > 760);
  const [sidebarWidth, setSidebarWidth] = useState(() => innerWidth > 1000 ? 276 : 244);
  const sidebarRef = useRef<HTMLElement>(null);
  const [mobile, setMobile] = useState(() => innerWidth <= 760);
  const [creating, setCreating] = useState<{ cwd: string }>();
  const [sessionMenu, setSessionMenu] = useState<{ row: WorkspaceSession; x: number; y: number }>();
  const [sessionAction, setSessionAction] = useState<{ row: WorkspaceSession; type: 'rename' | 'delete' }>();
  const creatingWorkspace = useRef(false);
  const [settings, setSettings] = useState(false);
  const [sendShortcut, setSendShortcut] =
    useState<SendShortcut>(storedSendShortcut);
  const [wrapLines, setWrapLines] = useState(storedWrapLines);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem("pi-webui-notifications") === "true",
  );
  const [notificationError, setNotificationError] = useState("");
  const [requestingPermission, setRequestingPermission] = useState(false);
  const completions = useRef(new Map<string, string | undefined>());
  const generating = useRef(new Set<string>());
  useEffect(() => {
    localStorage.setItem("pi-webui-send-shortcut", sendShortcut);
  }, [sendShortcut]);
  useEffect(() => {
    localStorage.setItem("pi-webui-wrap-lines", String(wrapLines));
  }, [wrapLines]);
  useEffect(() => {
    localStorage.setItem("pi-webui-notifications", String(notifications));
  }, [notifications]);
  const toggleNotifications = async (enabled: boolean) => {
    setNotificationError("");
    if (!enabled) {
      setNotifications(false);
      return;
    }
    if (!("Notification" in window) || !window.isSecureContext) {
      setNotificationError(
        "Desktop notifications are unavailable in this browser.",
      );
      return;
    }
    setRequestingPermission(true);
    try {
      const permission = await Notification.requestPermission();
      setNotifications(permission === "granted");
      if (permission !== "granted")
        setNotificationError(
          "Allow notifications in your browser settings to enable them.",
        );
    } catch (reason) {
      setNotificationError((reason as Error).message);
    } finally {
      setRequestingPermission(false);
    }
  };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(
    () => localStorage.getItem("pi-webui-theme") || "system",
  );
  const select = (id = "") => {
    const target = `#/pi/${encodeURIComponent(id)}`;
    if (
      location.hash !== target &&
      document.querySelector("[data-unsaved-file-edit]") &&
      !window.confirm("Discard your unsaved file edit?")
    )
      return;
    location.hash = target;
    if (innerWidth <= 760) setSidebar(false);
  };
  useEffect(() => {
    const change = () => setLocation(route());
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    localStorage.setItem("pi-webui-theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const catalogConnected = useStream<{
    defaultCwd: string;
    sessions: SessionRow[];
  }>("/pi/catalog/stream", ([data]) => {
    for (const session of data.sessions) {
      const completed = session.completion;
      if (session.running) generating.current.add(session.id);
      if (
        completed &&
        generating.current.has(session.id) &&
        completions.current.get(session.id) !== completed.id &&
        notifications &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification(
            session.name || basename(session.cwd),
            { body: completed.text, tag: `${session.id}:${completed.id}` },
          );
          notification.onclick = () => {
            window.focus();
            select(session.id);
            notification.close();
          };
        } catch (reason) {
          setNotificationError((reason as Error).message);
        }
      }
      if (!session.running) generating.current.delete(session.id);
      if (completed || !completions.current.has(session.id))
        completions.current.set(session.id, completed?.id);
    }
    setSessions(data.sessions);
    setDefaultCwd(data.defaultCwd);
    setCatalogLoaded(true);
  });
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const rows = await api<HistoryRow[]>("/pi/history");
        if (!disposed) {
          setHistory(rows);
          setHistoryLoaded(true);
          setHistoryError("");
        }
      } catch (error) {
        if (!disposed) {
          setHistoryLoaded(true);
          setHistoryError((error as Error).message);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [catalogConnected]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "b") {
        event.preventDefault();
        setSidebar((value) => !value);
      }
      if (
        event.key === "Escape" &&
        innerWidth <= 760 &&
        !document.querySelector("dialog[open]")
      )
        setSidebar(false);
    };
    addEventListener("keydown", keydown);
    return () => removeEventListener("keydown", keydown);
  }, []);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const change = () => {
      setMobile(media.matches);
      if (media.matches) setSidebar(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const selectedSession = sessions.find((session) => session.id === id);
  const catalog = useMemo(
    () => workspaceSessions(sessions, history),
    [sessions, history],
  );
  const currentWorkspaces = useMemo(
    () => [...new Set(catalog.map((session) => session.cwd))],
    [catalog],
  );
  const orderedWorkspaces = useMemo(
    () => workspaceOrder(workspacePositions, currentWorkspaces),
    [workspacePositions, currentWorkspaces],
  );
  const workspaces = orderedWorkspaces
    .filter((cwd) => currentWorkspaces.includes(cwd))
    .sort((a, b) => pinRank(`pi:${a}`) - pinRank(`pi:${b}`));
  useEffect(() => {
    if (!catalogLoaded || !historyLoaded) return;
    setWorkspacePositions((previous) => {
      const next = workspaceOrder(previous, currentWorkspaces);
      return next.length === previous.length ? previous : next;
    });
  }, [currentWorkspaces, catalogLoaded, historyLoaded]);
  const newSession = (cwd = selectedSession?.cwd || defaultCwd) =>
    setCreating({ cwd });
  const createInWorkspace = async (cwd: string, source?: string) => {
    if (creatingWorkspace.current) return;
    creatingWorkspace.current = true;
    setOpening(`new:${cwd}`);
    setError('');
    try {
      onCreated(await api<Session>('/pi/sessions', { cwd, source }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      creatingWorkspace.current = false;
      setOpening('');
    }
  };
  const onCreated = (session: Session) => {
    setQuery("");
    setSessions((current) => [
      {
        ...session,
        running: "running" in session ? Boolean(session.running) : false,
        waiting: "waiting" in session ? Boolean(session.waiting) : false,
      },
      ...current.filter((row) => row.id !== session.id),
    ]);
    setOpeningHistory(undefined);
    setCreating(undefined);
    select(session.id);
  };

  useEffect(() => {
    if (!id.startsWith("cli:") || selectedSession || !catalogConnected) return;
    const saved = history.find((row) => `cli:${row.id}` === id);
    if (!saved) return;
    let disposed = false;
    void api<Session>("/pi/attach", { path: saved.path })
      .then((session) => {
        if (!disposed) onCreated(session);
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [id, history, catalogConnected]);

  const openSession = async (row: WorkspaceSession) => {
    if (row.session) return select(row.session.id);
    if (!row.history || opening) return;
    setOpening(row.key);
    setError("");
    try {
      const active = await api<Session | null>("/pi/attach", {
        path: row.history.path,
      });
      if (active) onCreated(active);
      else setOpeningHistory(row.history);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setOpening("");
    }
  };

  const matchesQuery = (row: WorkspaceSession) =>
    `${row.name} ${row.cwd}`.toLowerCase().includes(query.toLowerCase());
  const renderSession = (row: WorkspaceSession, bookmarked = false) => {
    const unread = activity[sessionKey(row)];
    return (
      <button
        key={row.key}
        className={`session-row ${bookmarked ? 'bookmarked' : ''} ${id === row.session?.id ? 'selected' : ''}`}
        disabled={Boolean(opening) && Boolean(row.history)}
        onClick={() => void openSession(row)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          const bounds = event.currentTarget.getBoundingClientRect();
          setSessionMenu({ row, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom });
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            setSessionMenu({ row, x: bounds.left, y: bounds.bottom });
          }
        }}
        aria-haspopup="menu"
        title={bookmarked ? `${row.name}\n${row.cwd}` : row.name}
      >
        <span>
          <span className="session-indicator">
            {row.session?.waiting ? (
              <span className="state-dot blocked" title="Waiting for input" aria-label="Waiting for input" />
            ) : row.session?.running || opening === row.key ? (
              <LoaderCircle size={13} className="spin accent" aria-label="Running" />
            ) : unread?.unread ? (
              <span className={`state-dot ${unread.error ? 'unread-error' : 'unread-complete'}`}
                title={unread.error ? 'Unread error' : 'Unread completion'}
                aria-label={unread.error ? 'Unread error' : 'Unread completion'} />
            ) : bookmarked ? <Bookmark size={13} /> : null}
          </span>
          <span className="session-label">{row.name}</span>
        </span>
        <small>{age(row.updatedAt)}</small>
      </button>
    );
  };

  return (
    <div className={`app ${sidebar ? "sidebar-open" : "sidebar-closed"}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className="sidebar"
        ref={sidebarRef}
        aria-label="Workspaces and sessions"
        inert={!sidebar}
      >
        <div className="sidebar-actions">
          <button className="new-session" onClick={() => newSession()}>
            <MessageCirclePlus size={18} />
            New session
          </button>
          <IconButton
            label="Collapse sidebar"
            onClick={() => setSidebar(false)}
          >
            <PanelLeft size={19} />
          </IconButton>
        </div>
        <div className="workspace-list">
          {catalog.filter((row) => bookmarks.includes(sessionKey(row)) && matchesQuery(row))
            .map((row) => renderSession(row, true))}
          <div className="sidebar-section">
            <span>Workspaces</span>
            <IconButton
              label="Search sessions"
              onClick={() => {
                setSearching(!searching);
                setQuery("");
              }}
            >
              <Search size={17} />
            </IconButton>
            <IconButton label="Add workspace" onClick={() => newSession()}>
              <FolderPlus size={18} />
            </IconButton>
          </div>
          {searching && (
            <label className="sidebar-search">
              <input
                autoFocus
                aria-label="Search sessions"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {workspaces.map((cwd) => {
            const rows = catalog.filter(
              (row) =>
                row.cwd === cwd && !bookmarks.includes(sessionKey(row)) && matchesQuery(row),
            );
            if (query && !rows.length) return null;
            return (
              <Workspace
                key={`pi:${cwd}`}
                title={basename(cwd)}
                path={cwd}
                selectedKey={id}
                query={query}
                onNew={() => void createInWorkspace(cwd)}
                creating={opening === `new:${cwd}`}
                pinned={workspacePins.includes(`pi:${cwd}`)}
                onPin={() => togglePin(`pi:${cwd}`)}
                rows={rows.map((row) => ({
                  key: row.key,
                  content: renderSession(row),
                }))}
              />
            );
          })}
          {catalog.length === 0 && (
            <p className="sidebar-empty">No sessions</p>
          )}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setSettings(true)}>
            <Settings size={18} />
            Settings
          </button>
        </div>
        {sidebar && <ResizeHandle
          direction="horizontal"
          label="Resize sidebar"
          getSize={() => sidebarRef.current!.getBoundingClientRect().width}
          onResize={(size) => setSidebarWidth(Math.max(200, Math.min(size, mobile ? innerWidth * 0.84 : innerWidth - 360)))}
        />}
      </aside>
      <main inert={mobile && sidebar}>
        <ErrorNotice error={error || historyError} />
        {selectedSession ? (
          <PiView
            key={id}
            session={selectedSession}
            sendShortcut={sendShortcut}
            wrapLines={wrapLines}
            onSession={onCreated}
            onToggle={() => setSidebar(!sidebar)}
            onCopy={async () => {
              if (!selectedSession.file) return;
              onCreated(
                await api<Session>("/pi/sessions", {
                  cwd: selectedSession.cwd,
                  source: selectedSession.file,
                }),
              );
            }}
            onResume={
              selectedSession.kind === "cli" && selectedSession.file
                ? () =>
                    setOpeningHistory({
                      path: selectedSession.file!,
                      cwd: selectedSession.cwd,
                      name: selectedSession.name,
                      updatedAt: selectedSession.updatedAt,
                    })
                : undefined
            }
            onSource={
              selectedSession.source
                ? () =>
                    void openSession({
                      key: selectedSession.source!,
                      cwd: selectedSession.cwd,
                      name: selectedSession.name,
                      updatedAt: selectedSession.updatedAt,
                      history: {
                        path: selectedSession.source!,
                        cwd: selectedSession.cwd,
                        name: selectedSession.name,
                        updatedAt: selectedSession.updatedAt,
                      },
                    })
                : undefined
            }
          />
        ) : (
          <div className="session-view">
            <header className="session-header empty-header">
              <IconButton
                label="Toggle sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                <PanelLeft size={19} />
              </IconButton>
            </header>
            <div className="empty-session">
              <div className="hero-title">
                <span className="pi-mark">π</span>
                <h2>New session</h2>
              </div>
              <button
                className="workspace-context"
                onClick={() => newSession()}
              >
                <FolderOpen size={18} />
                Choose workspace
                <ChevronDown size={15} />
              </button>
              <div onClick={() => newSession()}>
                <Composer
                  id="empty"
                  sendShortcut={sendShortcut}
                  disabled
                  placeholder="Choose a workspace to start a session"
                  onSend={async () => {}}
                  toolbar={<span className="muted">pi</span>}
                />
              </div>
            </div>
          </div>
        )}
      </main>
      {sessionMenu && (
        <SessionMenu x={sessionMenu.x} y={sessionMenu.y}
          available={Boolean(sessionMenu.row.session?.file || sessionMenu.row.history?.path)}
          bookmarked={bookmarks.includes(sessionKey(sessionMenu.row))}
          onClose={() => setSessionMenu(undefined)}
          onAction={(type) => {
            const row = sessionMenu.row;
            setSessionMenu(undefined);
            if (type === 'bookmark') {
              const key = sessionKey(row);
              setBookmarks((current) => current.includes(key)
                ? current.filter((item) => item !== key) : [...current, key]);
            } else if (type === 'copy') void createInWorkspace(row.cwd, row.session?.file || row.history?.path);
            else setSessionAction({ row, type });
          }} />
      )}
      {sessionAction && (
        <SessionActionDialog row={sessionAction.row} type={sessionAction.type}
          onClose={() => setSessionAction(undefined)}
          onDone={(name) => {
            const file = sessionAction.row.session?.file || sessionAction.row.history?.path;
            if (sessionAction.type === 'delete') {
              const key = sessionKey(sessionAction.row);
              setBookmarks((current) => current.filter((item) => item !== key));
              setActivity((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
              setHistory((rows) => rows.filter((row) => row.path !== file));
              setSessions((rows) => rows.filter((row) => row.file !== file));
              if (selectedSession?.file === file) select();
            } else {
              setHistory((rows) => rows.map((row) => row.path === file ? { ...row, name } : row));
              setSessions((rows) => rows.map((row) => row.file === file ? { ...row, name } : row));
            }
            setSessionAction(undefined);
          }} />
      )}
      {openingHistory && (
        <OpenHistoryDialog
          key={openingHistory.path}
          history={openingHistory}
          onClose={() => setOpeningHistory(undefined)}
          onOpened={onCreated}
        />
      )}
      {creating && (
        <CreateDialog
          cwd={creating.cwd}
          onClose={() => setCreating(undefined)}
          onPi={onCreated}
        />
      )}
      {settings && (
        <Modal title="Settings" onClose={() => setSettings(false)}>
          <label className="setting-row">
            Appearance
            <select
              aria-label="Appearance"
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="setting-row">
            Send message
            <select
              aria-label="Send message shortcut"
              value={sendShortcut}
              onChange={(event) =>
                setSendShortcut(event.target.value as SendShortcut)
              }
            >
              {Object.entries(sendShortcuts).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row">
            Wrap file lines
            <input
              type="checkbox"
              aria-label="Wrap file lines"
              checked={wrapLines}
              onChange={(event) => setWrapLines(event.target.checked)}
            />
          </label>
          <label className="setting-row">
            Generation complete notifications
            <input
              type="checkbox"
              aria-label="Generation complete notifications"
              checked={notifications}
              disabled={requestingPermission}
              onChange={(event) =>
                void toggleNotifications(event.target.checked)
              }
            />
          </label>
          <ErrorNotice error={notificationError} />
          <p className="settings-note">
            Models, credentials and extensions use your existing pi
            configuration. Tools run with your local user's permissions.
          </p>
        </Modal>
      )}
    </div>
  );
}

function SessionActionDialog({ row, type, onClose, onDone }: {
  row: WorkspaceSession;
  type: 'rename' | 'delete';
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(row.session?.name || row.history?.name || row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deleting = type === 'delete';
  return (
    <Modal title={deleting ? 'Delete session' : 'Rename session'} dismissible={!busy} onClose={onClose}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await api(`/pi/${type}`, { path: row.session?.file || row.history?.path, name: name.trim(), confirmed: deleting });
          onDone(name.trim());
        } catch (reason) {
          setError((reason as Error).message);
          setBusy(false);
        }
      }}>
        {deleting ? <p>Delete “{row.name}”? Its history will be moved to the local trash. An active Web run will stop. Close the CLI first if it owns this session.</p> :
          <label>Session name<input autoFocus aria-label="Session name" maxLength={200} required value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (!deleting && !name.trim())}>{busy ? 'Saving…' : deleting ? 'Delete' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CreateDialog({
  cwd: initialCwd,
  onClose,
  onPi,
}: {
  cwd: string;
  onClose: () => void;
  onPi: (session: Session) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  const [history, setHistory] = useState<HistoryRow[]>();
  const [resuming, setResuming] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async (source?: HistoryRow) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onPi(
        await api<Session>("/pi/sessions", {
          cwd: source?.cwd || cwd,
          source: source?.path,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New session"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <nav className="dialog-tabs">
        <button
          aria-current={!resuming ? "page" : undefined}
          onClick={() => setResuming(false)}
        >
          New
        </button>
        <button
          aria-current={resuming ? "page" : undefined}
          onClick={async () => {
            setResuming(true);
            if (!history) {
              try {
                setHistory(await api("/pi/history"));
              } catch (error) {
                setError((error as Error).message);
              }
            }
          }}
        >
          Copy
        </button>
      </nav>
      <ErrorNotice error={error} />
      {resuming ? (
        <>
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="Search saved sessions"
              placeholder="Search saved sessions"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <p className="settings-note">
            Continue in a copy. The original CLI session is left unchanged.
          </p>
          <div className="history-list">
            {history ? (
              history
                .filter((session) =>
                  `${session.name} ${session.cwd}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .slice(0, 100)
                .map((session) => (
                  <button
                    key={session.path}
                    disabled={busy}
                    onClick={() => void create(session)}
                  >
                    <span>{session.name}</span>
                    <small>
                      {basename(session.cwd)} · {age(session.updatedAt)}
                    </small>
                  </button>
                ))
            ) : (
              <p>Loading sessions…</p>
            )}
            {history?.length === 0 && <p>No saved sessions.</p>}
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor="workspace-path">Working directory</label>
          <WorkspacePathInput value={cwd} onChange={setCwd} />
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || !cwd.trim()}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              Create session
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
