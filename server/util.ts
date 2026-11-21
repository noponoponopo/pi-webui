import { homedir } from 'node:os';
import { join } from 'node:path';

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const expandHome = (path: string) =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
