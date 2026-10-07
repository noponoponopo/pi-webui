import type { TerminalUpdate } from '../shared/types';
import { directory } from './store';

type Runtime = {
  terminal: Bun.Terminal;
  process: Bun.Subprocess;
  output: string;
  closed: boolean;
  listeners: Set<(update: TerminalUpdate) => void>;
};

export class Terminals {
  private readonly sessions = new Map<string, Runtime>();

  constructor(private readonly shell = process.env.SHELL || '/bin/sh') {}

  create(cwd: string) {
    const path = directory(cwd);
    const id = crypto.randomUUID();
    const decoder = new TextDecoder();
    let runtime: Runtime;
    const emit = (text: string, closed = false) => {
      runtime.output = (runtime.output + text).slice(-1024 * 1024);
      runtime.closed ||= closed;
      for (const send of runtime.listeners) send({ text, closed: runtime.closed });
    };
    const child = Bun.spawn([this.shell, '-i'], {
      cwd: path,
      env: { ...process.env, TERM: 'xterm-256color' },
      terminal: {
        cols: 80,
        rows: 24,
        data: (_, data) => emit(decoder.decode(data, { stream: true })),
        exit: (terminal) => {
          emit(decoder.decode(), true);
          terminal.close();
        },
      },
    });
    runtime = {
      terminal: child.terminal!,
      process: child,
      output: '',
      closed: false,
      listeners: new Set(),
    };
    this.sessions.set(id, runtime);
    return { id };
  }

  subscribe(id: string, send: (update: TerminalUpdate) => void) {
    const runtime = this.sessions.get(id);
    send({
      text: runtime?.output || '',
      reset: true,
      closed: runtime?.closed ?? true,
    });
    if (!runtime) return () => {};

    runtime.listeners.add(send);
    return () => {
      runtime.listeners.delete(send);
    };
  }

  private active(id: string) {
    const runtime = this.sessions.get(id);
    if (!runtime || runtime.closed) throw new Error('This terminal has been closed');
    return runtime;
  }

  input(id: string, text: string) {
    this.active(id).terminal.write(text);
  }

  resize(id: string, cols: number, rows: number) {
    if (
      ![cols, rows].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 1000,
      )
    )
      throw new Error('Invalid terminal size');
    this.active(id).terminal.resize(cols, rows);
  }

  async close(id: string) {
    const runtime = this.sessions.get(id);
    if (!runtime) return;
    this.sessions.delete(id);
    runtime.process.kill('SIGHUP');
    runtime.terminal.close();
    if (!runtime.closed) {
      runtime.closed = true;
      for (const send of runtime.listeners)
        send({ text: '', closed: true });
    }
    runtime.listeners.clear();
    const timeout = setTimeout(() => runtime.process.kill('SIGKILL'), 1000);
    try {
      await runtime.process.exited;
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
