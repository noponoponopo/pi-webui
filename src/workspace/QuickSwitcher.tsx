import { useState } from "react";
import { Search } from "lucide-react";
import type { WorkspaceSession } from "../../shared/workspaces";
import { age, basename } from "../lib/api";
import { Modal } from "../components/ui";

export function QuickSwitcher({
  catalog,
  theme,
  onClose,
  onSelectSession,
  onNewSession,
  onToggleSidebar,
  onCycleTheme,
  onOpenSettings,
}: {
  catalog: WorkspaceSession[];
  theme: string;
  onClose: () => void;
  onSelectSession: (row: WorkspaceSession) => void;
  onNewSession: () => void;
  onToggleSidebar: () => void;
  onCycleTheme: () => void;
  onOpenSettings: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const q = filter.trim().toLowerCase();
  const actions = [
    { key: "action:new", label: "New session", meta: "Create a session in any workspace", run: onNewSession },
    { key: "action:sidebar", label: "Toggle sidebar", meta: "⌘B", run: onToggleSidebar },
    { key: "action:theme", label: `Switch theme (current: ${theme})`, meta: "System / Dark / Light", run: onCycleTheme },
    { key: "action:settings", label: "Open settings", meta: "Preferences", run: onOpenSettings },
  ].filter((item) => !q || `${item.label} ${item.meta}`.toLowerCase().includes(q));
  const sessions = catalog
    .filter((row) => !q || `${row.name} ${row.cwd}`.toLowerCase().includes(q))
    .slice(0, 25);
  const entries = [
    ...sessions.map((row) => ({
      key: `session:${row.key}`,
      label: row.name,
      meta: `${basename(row.cwd)} · ${age(row.updatedAt)}`,
      run: () => onSelectSession(row),
    })),
    ...actions,
  ];
  const activeIndex = entries.length ? Math.min(selected, entries.length - 1) : 0;
  return (
    <Modal title="Quick switch" onClose={onClose}>
      <label className="search-field">
        <Search size={16} />
        <input
          autoFocus
          aria-label="Jump to session or action"
          placeholder="Jump to session or action…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (!entries.length) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((activeIndex + 1) % entries.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((activeIndex + entries.length - 1) % entries.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              entries[activeIndex]?.run();
            }
          }}
        />
      </label>
      <div className="history-list quick-switcher-list" role="listbox">
        {entries.map((entry, index) => (
          <button
            key={entry.key}
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "selected" : undefined}
            onMouseEnter={() => setSelected(index)}
            onClick={entry.run}
          >
            <span>{entry.label}</span>
            <small>{entry.meta}</small>
          </button>
        ))}
        {entries.length === 0 && <p className="empty-note">No matching sessions or actions.</p>}
      </div>
    </Modal>
  );
}
