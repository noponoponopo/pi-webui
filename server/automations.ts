import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Session } from '../shared/types';

export type AutomationTask = {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  lastSessionId?: string;
  lastStatus?: 'ok' | 'error' | 'running';
  lastError?: string;
  nextRunAt?: number;
  createdAt: number;
};

export type AutomationInput = {
  name: string;
  cwd: string;
  prompt: string;
  intervalMinutes: number;
  enabled?: boolean;
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60 * 24 * 30;

function clampInterval(value: number) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < MIN_INTERVAL) return MIN_INTERVAL;
  return Math.min(MAX_INTERVAL, n);
}

export class Automations {
  private readonly file: string;
  private tasks: AutomationTask[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private running = new Set<string>();

  constructor(
    dataDir: string,
    private readonly execute: (task: AutomationTask) => Promise<Session>,
  ) {
    this.file = join(dataDir, 'automations.json');
    this.load();
    this.timer = setInterval(() => void this.tick(), 30_000);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) {
        this.tasks = parsed.filter(
          (item): item is AutomationTask =>
            item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.cwd === 'string' &&
            typeof item.prompt === 'string',
        );
      }
    } catch {
      this.tasks = [];
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): AutomationTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  create(input: AutomationInput): AutomationTask {
    const name = input.name.trim();
    const cwd = input.cwd.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error('Task name is required');
    if (!cwd) throw new Error('Workspace path is required');
    if (!prompt) throw new Error('Prompt is required');
    const intervalMinutes = clampInterval(input.intervalMinutes);
    const enabled = input.enabled !== false;
    const now = Date.now();
    const task: AutomationTask = {
      id: crypto.randomUUID(),
      name,
      cwd,
      prompt,
      intervalMinutes,
      enabled,
      nextRunAt: enabled ? now + intervalMinutes * 60_000 : undefined,
      createdAt: now,
    };
    this.tasks.unshift(task);
    this.save();
    return { ...task };
  }

  update(id: string, patch: Partial<AutomationInput>): AutomationTask {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Automation task not found');
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('Task name is required');
      task.name = name;
    }
    if (patch.cwd !== undefined) {
      const cwd = patch.cwd.trim();
      if (!cwd) throw new Error('Workspace path is required');
      task.cwd = cwd;
    }
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim();
      if (!prompt) throw new Error('Prompt is required');
      task.prompt = prompt;
    }
    if (patch.intervalMinutes !== undefined) {
      task.intervalMinutes = clampInterval(patch.intervalMinutes);
    }
    if (patch.enabled !== undefined) {
      task.enabled = Boolean(patch.enabled);
    }
    if (task.enabled) {
      if (!task.nextRunAt || patch.intervalMinutes !== undefined || patch.enabled === true) {
        task.nextRunAt = Date.now() + task.intervalMinutes * 60_000;
      }
    } else {
      task.nextRunAt = undefined;
    }
    this.save();
    return { ...task };
  }

  remove(id: string): void {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((item) => item.id !== id);
    if (this.tasks.length === before) throw new Error('Automation task not found');
    this.save();
  }

  async runNow(id: string): Promise<{ task: AutomationTask; session: Session }> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Automation task not found');
    if (this.running.has(task.id)) throw new Error('Task is already running');
    this.running.add(task.id);
    task.lastStatus = 'running';
    task.lastError = undefined;
    task.lastRunAt = Date.now();
    this.save();
    try {
      const session = await this.execute(task);
      task.lastStatus = 'ok';
      task.lastSessionId = session.id;
      task.nextRunAt = task.enabled ? Date.now() + task.intervalMinutes * 60_000 : undefined;
      this.save();
      return { task: { ...task }, session };
    } catch (error) {
      task.lastStatus = 'error';
      task.lastError = (error as Error).message || 'Execution failed';
      task.nextRunAt = task.enabled ? Date.now() + task.intervalMinutes * 60_000 : undefined;
      this.save();
      throw error;
    } finally {
      this.running.delete(task.id);
    }
  }

  private async tick() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (!task.enabled || this.running.has(task.id)) continue;
      if (task.nextRunAt !== undefined && task.nextRunAt <= now) {
        void this.runNow(task.id).catch(() => {});
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
