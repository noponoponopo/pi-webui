import { expect, spyOn, test } from 'bun:test';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const nativeExec = execFile as unknown as Record<symbol, (
  command: string, args: string[], options?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>>;

test('file selection returns original paths without reading files, including cancellation and errors', async () => {
  const platform = process.platform;
  const cwd = '/tmp/project with spaces';
  const paths = ['/tmp/画像 file.png', '/tmp/a"b.pdf', '/tmp/trailing space '];
  let cancelled = false;
  let failure = false;
  const originalExec = nativeExec[promisify.custom];
  const exec = spyOn(nativeExec, promisify.custom).mockImplementation(async (command, args, options) => {
    if (failure) throw new Error('Picker failed');
    let stdout: string;
    if (command === 'osascript') {
      expect(args[4]).toBe(cwd);
      stdout = runInNewContext(`${args[3]}\nrun(args)`, {
        args: [cwd],
        Path: (path: string) => path,
        Application: {
          currentApplication: () => ({
            chooseFile: (options: { defaultLocation: string; multipleSelectionsAllowed: boolean }) => {
              expect(options.defaultLocation).toBe(cwd);
              expect(options.multipleSelectionsAllowed).toBe(true);
              if (cancelled) throw { errorNumber: -128 };
              return paths.map((path) => ({ toString: () => path }));
            },
          }),
        },
      });
    } else if (command === 'powershell.exe') {
      expect(options?.env?.PI_WEBUI_PICKER_CWD).toBe(cwd);
      stdout = JSON.stringify(cancelled ? [] : paths);
    } else {
      expect(command).toBe('zenity');
      expect(args).toContain(`--filename=${cwd}/`);
      if (cancelled) throw Object.assign(new Error('Cancelled'), { code: 1 });
      stdout = paths.join('\n') + '\n';
    }
    return { stdout, stderr: '' };
  });
  try {
    const { pickFiles } = await import(`${import.meta.dir}/native-files.ts?picker-test`);
    for (const value of ['darwin', 'win32', 'linux']) {
      Object.defineProperty(process, 'platform', { value });
      cancelled = false;
      failure = false;
      expect(await pickFiles(cwd)).toEqual(paths);
      cancelled = true;
      expect(await pickFiles(cwd)).toEqual([]);
      failure = true;
      await expect(pickFiles(cwd)).rejects.toThrow('Picker failed');
    }
  } finally {
    exec.mockRestore();
    exec.mockImplementation(originalExec);
    Object.defineProperty(process, 'platform', { value: platform });
  }
});
