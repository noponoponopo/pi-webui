import { useEffect, useState } from "react";
import {
  Clock,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Session } from "../shared/types";
import { age, api, basename } from "./api";
import { WorkspacePathInput } from "./WorkspacePathInput";
import { ErrorNotice, IconButton, Modal } from "./ui";

export type AutomationTask = {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  lastSessionId?: string;
  lastStatus?: "ok" | "error" | "running";
  lastError?: string;
  nextRunAt?: number;
  createdAt: number;
};

function formatInterval(minutes: number) {
  if (minutes < 60) return `Every ${minutes}m`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "Daily" : `Every ${days}d`;
  }
  if (minutes % 60 === 0) return `Every ${minutes / 60}h`;
  return `Every ${minutes}m`;
}

export function AutomationsView({
  defaultCwd,
  onToggleSidebar,
  onOpenSession,
}: {
  defaultCwd: string;
  onToggleSidebar: () => void;
  onOpenSession: (session: Session | string) => void;
}) {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"active" | "paused" | "all">("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AutomationTask | "new">();
  const [runningId, setRunningId] = useState("");

  const load = async () => {
    try {
      setTasks(await api<AutomationTask[]>("/automations"));
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const visible = tasks.filter((task) => {
    if (filter === "active" && !task.enabled) return false;
    if (filter === "paused" && task.enabled) return false;
    if (
      query.trim() &&
      !`${task.name} ${task.cwd} ${task.prompt}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    )
      return false;
    return true;
  });

  const toggleEnabled = async (task: AutomationTask) => {
    setError("");
    try {
      const updated = await api<AutomationTask>("/automations/update", {
        id: task.id,
        enabled: !task.enabled,
      });
      setTasks((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const removeTask = async (task: AutomationTask) => {
    if (!window.confirm(`Delete automation “${task.name}”?`)) return;
    setError("");
    try {
      await api("/automations/delete", { id: task.id });
      setTasks((list) => list.filter((item) => item.id !== task.id));
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const runNow = async (task: AutomationTask) => {
    setRunningId(task.id);
    setError("");
    try {
      const result = await api<{ task: AutomationTask; session: Session }>(
        "/automations/run",
        { id: task.id },
      );
      setTasks((list) =>
        list.map((item) => (item.id === result.task.id ? result.task : item)),
      );
      onOpenSession(result.session);
    } catch (reason) {
      setError((reason as Error).message);
      void load();
    } finally {
      setRunningId("");
    }
  };

  return (
    <div className="session-view automations-view">
      <header className="session-header">
        <IconButton label="Toggle sidebar" onClick={onToggleSidebar}>
          <PanelLeft size={19} />
        </IconButton>
        <h1>Automations</h1>
        <div className="header-actions">
          <button className="primary compact-primary" onClick={() => setEditing("new")}>
            <Plus size={15} />
            New task
          </button>
        </div>
      </header>
      <div className="automations-body">
        <div className="automations-controls">
          <div className="pill-tabs" role="tablist" aria-label="Filter automations">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["paused", "Paused"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? "selected" : undefined}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search-field automations-search">
            <Search size={15} />
            <input
              aria-label="Search automations"
              placeholder="Search automations…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <ErrorNotice error={error} />
        {loading ? (
          <p className="empty-note">Loading automations…</p>
        ) : visible.length === 0 ? (
          <div className="automations-empty">
            <Clock size={36} className="muted" />
            <p className="muted">
              {tasks.length === 0
                ? "Schedule recurring pi prompts to run automatically in any workspace."
                : "No matching automation tasks."}
            </p>
            {tasks.length === 0 && (
              <button className="new-session inline-cta" onClick={() => setEditing("new")}>
                <Plus size={16} />
                Create automation
              </button>
            )}
          </div>
        ) : (
          <div className="automations-list">
            {visible.map((task) => (
              <article className="automation-card" key={task.id}>
                <div className="automation-card-head">
                  <div className="automation-card-title">
                    <span
                      className={`state-dot ${
                        task.lastStatus === "error"
                          ? "unread-error"
                          : task.enabled
                            ? "done"
                            : ""
                      }`}
                    />
                    <strong>{task.name}</strong>
                    <span className="automation-badge">{formatInterval(task.intervalMinutes)}</span>
                  </div>
                  <div className="automation-card-actions">
                    <button
                      disabled={runningId === task.id}
                      onClick={() => void runNow(task)}
                      title="Run now"
                    >
                      {runningId === task.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      Run
                    </button>
                    <IconButton
                      label={task.enabled ? "Pause task" : "Resume task"}
                      onClick={() => void toggleEnabled(task)}
                    >
                      {task.enabled ? <Pause size={15} /> : <Play size={15} />}
                    </IconButton>
                    <IconButton label="Edit task" onClick={() => setEditing(task)}>
                      <Pencil size={15} />
                    </IconButton>
                    <IconButton label="Delete task" onClick={() => void removeTask(task)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                </div>
                <p className="automation-prompt">{task.prompt}</p>
                <div className="automation-meta">
                  <span title={task.cwd}>
                    <FolderOpen size={13} /> {basename(task.cwd)}
                  </span>
                  {task.lastRunAt && <span>Last run {age(task.lastRunAt)} ago</span>}
                  {task.lastError && <span className="automation-error">{task.lastError}</span>}
                  {task.lastSessionId && (
                    <button
                      className="automation-link"
                      onClick={() => onOpenSession(task.lastSessionId!)}
                    >
                      <ExternalLink size={12} /> Open last session
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <AutomationEditor
          task={editing === "new" ? undefined : editing}
          defaultCwd={defaultCwd}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setTasks((list) =>
              editing === "new"
                ? [saved, ...list]
                : list.map((item) => (item.id === saved.id ? saved : item)),
            );
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function AutomationEditor({
  task,
  defaultCwd,
  onClose,
  onSaved,
}: {
  task?: AutomationTask;
  defaultCwd: string;
  onClose: () => void;
  onSaved: (task: AutomationTask) => void;
}) {
  const [name, setName] = useState(task?.name || "");
  const [cwd, setCwd] = useState(task?.cwd || defaultCwd);
  const [prompt, setPrompt] = useState(task?.prompt || "");
  const [intervalMinutes, setIntervalMinutes] = useState(task?.intervalMinutes ?? 60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = task
        ? await api<AutomationTask>("/automations/update", {
            id: task.id,
            name,
            cwd,
            prompt,
            intervalMinutes,
          })
        : await api<AutomationTask>("/automations", {
            name,
            cwd,
            prompt,
            intervalMinutes,
            enabled: true,
          });
      onSaved(saved);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={task ? "Edit automation" : "New automation"} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={200}
            placeholder="Daily repo health check"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Workspace
          <WorkspacePathInput value={cwd} onChange={setCwd} />
        </label>
        <label>
          Interval (minutes)
          <div className="interval-row">
            <input
              type="number"
              min={1}
              max={43200}
              required
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(Number(event.target.value) || 60)}
            />
            {[15, 60, 360, 1440].map((mins) => (
              <button
                key={mins}
                type="button"
                className={intervalMinutes === mins ? "selected-pill" : "subtle-pill"}
                onClick={() => setIntervalMinutes(mins)}
              >
                {formatInterval(mins).replace("Every ", "")}
              </button>
            ))}
          </div>
        </label>
        <label>
          Prompt
          <textarea
            required
            rows={4}
            placeholder="Check git status, open PRs, and summarize any issues…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !cwd.trim() || !prompt.trim()}>
            {busy ? "Saving…" : task ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
