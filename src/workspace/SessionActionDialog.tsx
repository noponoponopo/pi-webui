import { useState } from "react";
import type { WorkspaceSession } from "../../shared/workspaces";
import { api } from "../lib/api";
import { ErrorNotice, Modal } from "../components/ui";

export function SessionActionDialog({ row, type, onClose, onDone }: {
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
