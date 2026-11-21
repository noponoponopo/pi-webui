import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  Clock,
  FolderOpen,
  FolderPlus,
  List,
  LoaderCircle,
  MessageCirclePlus,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { HistoryRow, Session, SessionRow } from "../shared/types";
import { age, api, basename, useStream } from "./lib/api";
import { Composer } from "./session/Composer";
import {
  applyTypography,
  fontSizes,
  monoFonts,
  sendShortcuts,
  storedFontSize,
  storedMonoFont,
  storedSendShortcut,
  storedUiFont,
  storedWrapLines,
  uiFonts,
  type FontSize,
  type MonoFont,
  type SendShortcut,
  type UiFont,
} from "./lib/preferences";
import { OpenHistoryDialog } from "./workspace/OpenHistoryDialog";
import { Workspace } from "./workspace/Workspace";
import { ResizeHandle } from "./components/ResizableSplit";
import { SessionMenu } from "./workspace/SessionMenu";
import { AutomationsView } from "./automations/AutomationsView";
import { PresetsModal } from "./workspace/PresetsModal";
import { savePresets, storedPresets, type SessionPreset } from "./lib/presets";
import { sessionKey, storedActivity, storedBookmarks, updateActivity } from "./lib/session-activity";
import {
  workspaceOrder,
  workspaceSessions,
  type WorkspaceSession,
} from "../shared/workspaces";
import { PiView } from "./session/PiView";
import { CreateDialog } from "./workspace/CreateDialog";
import { QuickSwitcher } from "./workspace/QuickSwitcher";
import { SessionActionDialog } from "./workspace/SessionActionDialog";
import { ErrorNotice, IconButton, Modal } from "./components/ui";

function playCompletionChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
    osc.onended = () => void ctx.close();
  } catch {}
}

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
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pi-webui-workspace-open") || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem("pi-webui-workspace-open", JSON.stringify(openWorkspaces));
  }, [openWorkspaces]);
  const [sidebarView, setSidebarView] = useState<'workspaces' | 'flat'>(() =>
    localStorage.getItem("pi-webui-sidebar-view") === "flat" ? "flat" : "workspaces",
  );
  const [sidebarFilter, setSidebarFilter] = useState<'all' | 'active' | 'bookmarked'>(() => {
    const saved = localStorage.getItem("pi-webui-sidebar-filter");
    return saved === "active" || saved === "bookmarked" ? saved : "all";
  });
  const [sidebarSort, setSidebarSort] = useState<'updated' | 'manual' | 'name'>(() => {
    const saved = localStorage.getItem("pi-webui-sidebar-sort");
    return saved === "manual" || saved === "name" ? saved : "updated";
  });
  const [manualWorkspaceOrder, setManualWorkspaceOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pi-webui-workspace-order") || "[]");
      return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  const [draggedWorkspace, setDraggedWorkspace] = useState<string>();
  const [dragOverWorkspace, setDragOverWorkspace] = useState<string>();
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presets, setPresets] = useState<SessionPreset[]>(storedPresets);
  const [uiFont, setUiFont] = useState<UiFont>(storedUiFont);
  const [monoFont, setMonoFont] = useState<MonoFont>(storedMonoFont);
  const [fontSize, setFontSize] = useState<FontSize>(storedFontSize);
  const [reducedMotion, setReducedMotion] = useState(
    () => localStorage.getItem("pi-webui-reduced-motion") === "true",
  );
  const [notificationSound, setNotificationSound] = useState(
    () => localStorage.getItem("pi-webui-notification-sound") === "true",
  );
  const notificationSoundRef = useRef(notificationSound);
  notificationSoundRef.current = notificationSound;
  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? "reduced" : "standard";
    localStorage.setItem("pi-webui-reduced-motion", String(reducedMotion));
  }, [reducedMotion]);
  useEffect(() => {
    localStorage.setItem("pi-webui-notification-sound", String(notificationSound));
  }, [notificationSound]);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      document.documentElement.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("pi-webui-sidebar-view", sidebarView);
  }, [sidebarView]);
  useEffect(() => {
    localStorage.setItem("pi-webui-sidebar-filter", sidebarFilter);
  }, [sidebarFilter]);
  useEffect(() => {
    localStorage.setItem("pi-webui-sidebar-sort", sidebarSort);
  }, [sidebarSort]);
  useEffect(() => {
    localStorage.setItem("pi-webui-workspace-order", JSON.stringify(manualWorkspaceOrder));
  }, [manualWorkspaceOrder]);
  useEffect(() => {
    savePresets(presets);
  }, [presets]);
  useEffect(() => {
    applyTypography(uiFont, monoFont, fontSize);
    localStorage.setItem("pi-webui-ui-font", uiFont);
    localStorage.setItem("pi-webui-mono-font", monoFont);
    localStorage.setItem("pi-webui-font-size", fontSize);
  }, [uiFont, monoFont, fontSize]);
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
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let mode: "open" | "close" | null = null;
    const onTouchStart = (event: TouchEvent) => {
      if (innerWidth > 760 || event.touches.length !== 1) return;
      if (document.querySelector("dialog[open]")) return;
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      if (!sidebar && startX <= 28) mode = "open";
      else if (sidebar && startX <= Math.min(sidebarWidth, innerWidth * 0.84) + 24) mode = "close";
      else mode = null;
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!mode || !event.changedTouches.length) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (mode === "open" && dx > 0) setSidebar(true);
        if (mode === "close" && dx < 0) setSidebar(false);
      }
      mode = null;
    };
    addEventListener("touchstart", onTouchStart, { passive: true });
    addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      removeEventListener("touchstart", onTouchStart);
      removeEventListener("touchend", onTouchEnd);
    };
  }, [sidebar, sidebarWidth]);
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
    setAutomationsOpen(false);
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
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (meta) meta.content = resolved === "dark" ? "#141414" : "#ffffff";
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
      const newlyCompleted =
        completed &&
        generating.current.has(session.id) &&
        completions.current.get(session.id) !== completed.id;
      if (newlyCompleted && notificationSoundRef.current) {
        playCompletionChime();
      }
      if (
        newlyCompleted &&
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
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebar((value) => !value);
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuickOpen((value) => !value);
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
  const workspaces = useMemo(() => {
    const active = orderedWorkspaces.filter((cwd) => currentWorkspaces.includes(cwd));
    const manualRank = (cwd: string) => {
      const idx = manualWorkspaceOrder.indexOf(cwd);
      return idx < 0 ? manualWorkspaceOrder.length : idx;
    };
    return [...active].sort((a, b) => {
      const pinDiff = pinRank(`pi:${a}`) - pinRank(`pi:${b}`);
      if (pinDiff !== 0) return pinDiff;
      if (sidebarSort === "name") return basename(a).localeCompare(basename(b));
      if (sidebarSort === "manual") return manualRank(a) - manualRank(b);
      return 0;
    });
  }, [orderedWorkspaces, currentWorkspaces, workspacePins, sidebarSort, manualWorkspaceOrder]);
  const reorderWorkspace = (source: string, target: string) => {
    if (!source || !target || source === target) return;
    const base = [...workspaces];
    const from = base.indexOf(source);
    const to = base.indexOf(target);
    if (from < 0 || to < 0) return;
    base.splice(from, 1);
    base.splice(to, 0, source);
    setManualWorkspaceOrder(base);
    setSidebarSort("manual");
  };
  const launchPreset = async (preset: SessionPreset) => {
    const cwd = preset.cwd || selectedSession?.cwd || defaultCwd;
    if (!cwd) {
      setPresetsOpen(false);
      newSession();
      return;
    }
    setPresetsOpen(false);
    setError("");
    try {
      const created = await api<Session>("/pi/sessions", { cwd });
      if (preset.promptPrefix) {
        sessionStorage.setItem(`draft:${created.id}`, preset.promptPrefix);
      }
      if (preset.thinkingLevel) {
        void api(`/pi/${encodeURIComponent(created.id)}/command`, {
          type: "set_thinking_level",
          level: preset.thinkingLevel,
        }).catch(() => {});
      }
      onCreated(created);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
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
  const matchesFilter = (row: WorkspaceSession) => {
    if (sidebarFilter === "bookmarked") return bookmarks.includes(sessionKey(row));
    if (sidebarFilter === "active") {
      const unread = activity[sessionKey(row)];
      return Boolean(row.session?.running || row.session?.waiting || unread?.unread);
    }
    return true;
  };
  const renderSession = (row: WorkspaceSession, bookmarked = false, showWorkspace = false) => {
    const unread = activity[sessionKey(row)];
    return (
      <div
        key={row.key}
        className={`session-item ${id === row.session?.id ? 'selected' : ''}`}
      >
        <button
          className={`session-row ${bookmarked || showWorkspace ? 'bookmarked' : ''} ${id === row.session?.id ? 'selected' : ''}`}
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
          title={bookmarked || showWorkspace ? `${row.name}\n${row.cwd}` : row.name}
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
            <span className="session-label">
              {row.name}
              {showWorkspace && <span className="session-workspace-tag">{basename(row.cwd)}</span>}
            </span>
          </span>
          <small className="session-age">{age(row.updatedAt)}</small>
        </button>
        <IconButton
          className="icon-button session-more-btn"
          label={`Actions for ${row.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            setSessionMenu({ row, x: bounds.right, y: bounds.bottom });
          }}
        >
          <MoreHorizontal size={15} />
        </IconButton>
      </div>
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
        <nav className="sidebar-nav" aria-label="Workspace tools">
          <button
            className={automationsOpen ? "selected" : undefined}
            onClick={() => {
              setAutomationsOpen(true);
              if (innerWidth <= 760) setSidebar(false);
            }}
          >
            <Clock size={16} />
            <span>Automations</span>
          </button>
          <button onClick={() => setPresetsOpen(true)}>
            <Sparkles size={16} />
            <span>Presets</span>
            {presets.length > 0 && <small className="nav-count">{presets.length}</small>}
          </button>
        </nav>
        <div className="sidebar-section">
          <span>{sidebarView === "flat" ? "Sessions" : "Workspaces"}</span>
          <IconButton
            label="Search sessions"
            aria-pressed={searching}
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <Search size={17} />
          </IconButton>
          <div
            className="display-options-wrap"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setDisplayMenuOpen(false);
            }}
          >
            <IconButton
              label="Display options"
              aria-expanded={displayMenuOpen}
              aria-haspopup="menu"
              className={`icon-button ${sidebarView !== "workspaces" || sidebarFilter !== "all" ? "accent" : ""}`}
              onClick={() => setDisplayMenuOpen((open) => !open)}
            >
              <SlidersHorizontal size={16} />
            </IconButton>
            {displayMenuOpen && (
              <div className="menu display-options-menu" role="menu">
                <div className="menu-section-label">Group by</div>
                <button
                  role="menuitemradio"
                  aria-checked={sidebarView === "workspaces"}
                  onClick={() => {
                    setSidebarView("workspaces");
                    setDisplayMenuOpen(false);
                  }}
                >
                  <FolderOpen size={15} />
                  <span>Workspaces</span>
                  {sidebarView === "workspaces" && <Check size={14} className="menu-check" />}
                </button>
                <button
                  role="menuitemradio"
                  aria-checked={sidebarView === "flat"}
                  onClick={() => {
                    setSidebarView("flat");
                    setDisplayMenuOpen(false);
                  }}
                >
                  <List size={15} />
                  <span>Single list</span>
                  {sidebarView === "flat" && <Check size={14} className="menu-check" />}
                </button>
                <div className="menu-divider" />
                <div className="menu-section-label">Sort workspaces</div>
                {(
                  [
                    ["updated", "Recent activity"],
                    ["manual", "Manual (drag)"],
                    ["name", "Name (A–Z)"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={sidebarSort === value}
                    onClick={() => {
                      setSidebarSort(value);
                      setDisplayMenuOpen(false);
                    }}
                  >
                    <span>{label}</span>
                    {sidebarSort === value && <Check size={14} className="menu-check" />}
                  </button>
                ))}
                <div className="menu-divider" />
                <div className="menu-section-label">Filter</div>
                {(
                  [
                    ["all", "All sessions"],
                    ["active", "Active & unread"],
                    ["bookmarked", "Bookmarked"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={sidebarFilter === value}
                    onClick={() => {
                      setSidebarFilter(value);
                      setDisplayMenuOpen(false);
                    }}
                  >
                    <span>{label}</span>
                    {sidebarFilter === value && <Check size={14} className="menu-check" />}
                  </button>
                ))}
                {sidebarView === "workspaces" && (
                  <>
                    <div className="menu-divider" />
                    <button
                      role="menuitem"
                      onClick={() => {
                        const next: Record<string, boolean> = {};
                        for (const cwd of workspaces) next[cwd] = true;
                        setOpenWorkspaces(next);
                        setDisplayMenuOpen(false);
                      }}
                    >
                      <span>Expand all</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        const next: Record<string, boolean> = {};
                        for (const cwd of workspaces) next[cwd] = false;
                        setOpenWorkspaces(next);
                        setDisplayMenuOpen(false);
                      }}
                    >
                      <span>Collapse all</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
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
        <div className="workspace-list">
          {sidebarView === "flat" ? (
            <>
              {catalog
                .filter((row) => matchesFilter(row) && matchesQuery(row))
                .slice(0, 120)
                .map((row) =>
                  renderSession(row, bookmarks.includes(sessionKey(row)), true),
                )}
              {catalog.filter((row) => matchesFilter(row) && matchesQuery(row)).length === 0 && (
                <p className="sidebar-empty">No matching sessions</p>
              )}
            </>
          ) : (
            <>
              {catalog
                .filter((row) => bookmarks.includes(sessionKey(row)) && matchesFilter(row) && matchesQuery(row))
                .map((row) => renderSession(row, true))}
              {workspaces.map((cwd, index) => {
                const rows = catalog.filter(
                  (row) =>
                    row.cwd === cwd &&
                    !bookmarks.includes(sessionKey(row)) &&
                    matchesFilter(row) &&
                    matchesQuery(row),
                );
                if ((query || sidebarFilter !== "all") && !rows.length) return null;
                return (
                  <Workspace
                    key={`pi:${cwd}`}
                    title={basename(cwd)}
                    path={cwd}
                    selectedKey={id}
                    query={query}
                    defaultOpen={index === 0 && !id}
                    open={openWorkspaces[cwd]}
                    onOpenChange={(next) =>
                      setOpenWorkspaces((current) => ({ ...current, [cwd]: next }))
                    }
                    onNew={() => void createInWorkspace(cwd)}
                    creating={opening === `new:${cwd}`}
                    pinned={workspacePins.includes(`pi:${cwd}`)}
                    onPin={() => togglePin(`pi:${cwd}`)}
                    onDragStart={() => setDraggedWorkspace(cwd)}
                    onDragOver={(event) => {
                      if (!draggedWorkspace || draggedWorkspace === cwd) return;
                      event.preventDefault();
                      setDragOverWorkspace(cwd);
                    }}
                    onDragLeave={() => {
                      if (dragOverWorkspace === cwd) setDragOverWorkspace(undefined);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedWorkspace) reorderWorkspace(draggedWorkspace, cwd);
                      setDraggedWorkspace(undefined);
                      setDragOverWorkspace(undefined);
                    }}
                    dragOver={dragOverWorkspace === cwd}
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
            </>
          )}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setQuickOpen(true)} title="Quick switcher (⌘K)">
            <Search size={17} />
            <span>Quick switch</span>
            <kbd className="shortcut-kbd">⌘K</kbd>
          </button>
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
        {automationsOpen ? (
          <AutomationsView
            defaultCwd={selectedSession?.cwd || defaultCwd}
            onToggleSidebar={() => setSidebar(!sidebar)}
            onOpenSession={(target) => {
              if (typeof target === "string") select(target);
              else onCreated(target);
            }}
          />
        ) : selectedSession ? (
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
              <div className="hero-context-row">
                <button
                  className="workspace-context"
                  onClick={() => newSession()}
                >
                  <FolderOpen size={18} />
                  Choose workspace
                  <ChevronDown size={15} />
                </button>
                <button
                  className="workspace-context"
                  onClick={() => setPresetsOpen(true)}
                >
                  <Sparkles size={16} />
                  {presets.length ? `Presets (${presets.length})` : "Presets"}
                  <ChevronDown size={15} />
                </button>
              </div>
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
            else if (type === 'export-md' || type === 'export-jsonl') {
              const file = row.session?.file || row.history?.path;
              if (file) {
                const params = new URLSearchParams({
                  path: file,
                  format: type === 'export-jsonl' ? 'jsonl' : 'md',
                });
                location.assign(`/api/pi/export?${params}`);
              }
            }
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
      {presetsOpen && (
        <PresetsModal
          presets={presets}
          defaultCwd={selectedSession?.cwd || defaultCwd}
          onChange={setPresets}
          onLaunch={(preset) => void launchPreset(preset)}
          onClose={() => setPresetsOpen(false)}
        />
      )}
      {quickOpen && (
        <QuickSwitcher
          catalog={catalog}
          theme={theme}
          onClose={() => setQuickOpen(false)}
          onSelectSession={(row) => {
            setQuickOpen(false);
            void openSession(row);
          }}
          onNewSession={() => {
            setQuickOpen(false);
            newSession();
          }}
          onToggleSidebar={() => {
            setQuickOpen(false);
            setSidebar((value) => !value);
          }}
          onCycleTheme={() => {
            setTheme((current) =>
              current === "system" ? "dark" : current === "dark" ? "light" : "system",
            );
          }}
          onOpenSettings={() => {
            setQuickOpen(false);
            setSettings(true);
          }}
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
            UI font
            <select
              aria-label="UI font"
              value={uiFont}
              onChange={(event) => setUiFont(event.target.value as UiFont)}
            >
              {Object.entries(uiFonts).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row">
            Code font
            <select
              aria-label="Code font"
              value={monoFont}
              onChange={(event) => setMonoFont(event.target.value as MonoFont)}
            >
              {Object.entries(monoFonts).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row">
            Font size
            <select
              aria-label="Font size"
              value={fontSize}
              onChange={(event) => setFontSize(event.target.value as FontSize)}
            >
              {Object.entries(fontSizes).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
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
            Reduced motion
            <input
              type="checkbox"
              aria-label="Reduced motion"
              checked={reducedMotion}
              onChange={(event) => setReducedMotion(event.target.checked)}
            />
          </label>
          <label className="setting-row">
            Completion sound
            <input
              type="checkbox"
              aria-label="Completion sound"
              checked={notificationSound}
              onChange={(event) => setNotificationSound(event.target.checked)}
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
            Shortcuts: ⌘K quick switch · ⌘B sidebar · ⇧⌘B files pane · ⌃` terminal
          </p>
          <p className="settings-note">
            Models, credentials and extensions use your existing pi
            configuration. Tools run with your local user's permissions.
          </p>
        </Modal>
      )}
    </div>
  );
}
