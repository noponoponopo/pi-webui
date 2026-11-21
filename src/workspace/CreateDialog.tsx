import { useState } from "react";
import { LoaderCircle, Plus, Search } from "lucide-react";
import type { HistoryRow, Session } from "../../shared/types";
import { age, api, basename } from "../lib/api";
import { ErrorNotice, Modal } from "../components/ui";
import { WorkspacePathInput } from "./WorkspacePathInput";

export function CreateDialog({
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
