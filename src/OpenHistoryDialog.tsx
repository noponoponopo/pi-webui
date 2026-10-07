import { useState } from 'react';
import type { HistoryRow, Session } from '../shared/types';
import { api } from './api';
import { ErrorNotice, Modal } from './ui';

export function OpenHistoryDialog({
  history,
  onClose,
  onOpened,
}: {
  history: HistoryRow;
  onClose: () => void;
  onOpened: (session: Session) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async (operation: 'attach' | 'resume' | 'copy') => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const session = await api<Session | null>(
        operation === 'copy' ? '/pi/sessions' : `/pi/${operation}`,
        operation === 'copy'
          ? { cwd: history.cwd, source: history.path }
          : { path: history.path, cliClosed: closed },
      );
      if (!session)
        throw new Error(
          'CLI is not connected yet. Run /reload in that pi session, then connect again.',
        );
      onOpened(session);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Open session" onClose={onClose} dismissible={!busy}>
      <p>{history.name}</p>
      <p className="settings-note" title={history.path}>
        {history.cwd}
      </p>
      <p>
        If pi is running in a terminal, run <code>/reload</code> there and
        connect to the same session.
      </p>
      <ErrorNotice error={error} />
      <label className="setting-row">
        <span>The CLI session is closed</span>
        <input
          type="checkbox"
          checked={closed}
          disabled={busy}
          onChange={(event) => setClosed(event.target.checked)}
        />
      </label>
      <p className="settings-note">
        Resume in Web uses the original history. Copy starts an independent
        session.
      </p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void open('copy')}>
          Copy
        </button>
        <button disabled={busy || !closed} onClick={() => void open('resume')}>
          Resume in Web
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void open('attach')}
        >
          Connect CLI
        </button>
      </div>
    </Modal>
  );
}
