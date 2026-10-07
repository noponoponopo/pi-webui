import { useEffect, useRef, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import type { TerminalUpdate } from "../shared/types";
import { api, useStream } from "./api";
import { ErrorNotice, IconButton } from "./ui";

type Tab = { id: string; label: string };

export function TerminalPanel({ sessionId, cwd, onHide }: {
  sessionId: string;
  cwd: string;
  onHide: () => void;
}) {
  const storageKey = `terminals:${sessionId}`;
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved.filter((tab) =>
        typeof tab?.id === "string" && typeof tab.label === "string") : [];
    } catch { return []; }
  });
  const [selected, setSelected] = useState(tabs[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creating = useRef(false);
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(tabs));
  }, [tabs, storageKey]);

  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const label = `Terminal ${tabs.length + 1}`;
      const { id } = await api<{ id: string }>("/terminals", { cwd });
      const tab = { id, label };
      // Keep the newly created terminal recoverable even if the panel was hidden while opening it.
      sessionStorage.setItem(storageKey, JSON.stringify([...tabs, tab]));
      setTabs((current) => [...current, tab]);
      setSelected(tab.id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  useEffect(() => { if (!tabs.length) void create(); }, []);

  const close = async (tab: Tab) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/terminals/${encodeURIComponent(tab.id)}/close`, {});
      const remaining = tabs.filter((item) => item.id !== tab.id);
      setTabs(remaining);
      if (selected === tab.id) setSelected(remaining[0]?.id || "");
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <section className="terminal-panel" aria-label="Workspace terminals">
      <header className="terminal-tabs">
        <TerminalIcon size={15} />
        <div role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab) => (
            <div className="terminal-tab" key={tab.id}>
              <button role="tab" aria-selected={selected === tab.id} onClick={() => setSelected(tab.id)}>
                {tab.label}
              </button>
              <IconButton label={`Close ${tab.label}`} disabled={busy} onClick={() => void close(tab)}>
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </div>
        <IconButton label="New terminal" disabled={busy} onClick={() => void create()}><Plus size={16} /></IconButton>
        <IconButton label="Hide terminal" onClick={onHide}><X size={16} /></IconButton>
      </header>
      <ErrorNotice error={error} />
      {selected ? <TerminalScreen key={selected} id={selected} /> :
        <p className="empty-note">{busy ? "Opening terminal…" : "Open a terminal with +."}</p>}
    </section>
  );
}

function TerminalScreen({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const pending = useRef<TerminalUpdate[]>([]);
  const queue = useRef(Promise.resolve());
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const ready = useRef(false);
  const render = (update: TerminalUpdate) => {
    const term = terminal.current;
    if (!term) { pending.current.push(update); return; }
    const scroll = term.buffer.active.viewportY;
    const following = scroll >= term.buffer.active.baseY;
    if (update.reset) term.reset();
    term.write(update.text, () => {
      if (update.reset && !following) term.scrollToLine(scroll);
    });
  };
  const connected = useStream<TerminalUpdate>(`/terminals/${encodeURIComponent(id)}/stream`, (update) => {
    setClosed(update.closed);
    render(update);
  }, setError);
  ready.current = connected && !closed;
  const send = (action: string, body: object) => {
    if (!ready.current) return;
    queue.current = queue.current.then(async () => {
      await api(`/terminals/${encodeURIComponent(id)}/${action}`, body);
      setError("");
    }).catch((reason) => setError(reason.message));
  };
  useEffect(() => {
    const term = new Terminal({
      fontSize: 12, fontFamily: "Menlo, Monaco, monospace", scrollback: 500,
      cursorBlink: false, screenReaderMode: true,
      theme: { background: "#141414", foreground: "#eeeeee" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    for (const update of pending.current) render(update);
    pending.current = [];
    const input = term.onData((text) => send("input", { text }));
    const sized = term.onResize(({ cols, rows }) => send("resize", { cols, rows }));
    const resize = () => { if (host.current?.clientWidth && host.current.clientHeight) fit.fit(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    resize();
    term.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      sized.dispose();
      term.dispose();
      terminal.current = undefined;
    };
  }, [id]);
  useEffect(() => {
    const term = terminal.current;
    if (connected && !closed && term) send("resize", { cols: term.cols, rows: term.rows });
  }, [connected, closed]);
  return (
    <>
      <ErrorNotice error={error} />
      {!connected && <div className="notice">Connecting to terminal…</div>}
      {connected && closed && <div className="notice">This terminal has been closed.</div>}
      <div className="workspace-terminal" ref={host} aria-label="Terminal screen" />
    </>
  );
}
