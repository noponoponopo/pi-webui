import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { timeout: 15_000, windowsHide: true };

export async function pickFiles(cwd: string): Promise<string[]> {
  if (process.platform === 'darwin') {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', `
      function run(args) {
        const app = Application.currentApplication();
        app.includeStandardAdditions = true;
        try {
          return JSON.stringify(app.chooseFile({
            withPrompt: 'Select files to insert their paths',
            defaultLocation: Path(args[0]),
            multipleSelectionsAllowed: true
          }).map(String));
        } catch (error) {
          if (error.errorNumber === -128) return '[]';
          throw error;
        }
      }
    `, cwd]);
    return JSON.parse(stdout);
  }
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', `
      $ErrorActionPreference = 'Stop';
      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
      Add-Type -AssemblyName System.Windows.Forms;
      $dialog = [System.Windows.Forms.OpenFileDialog]::new();
      $dialog.Multiselect = $true;
      $dialog.InitialDirectory = $env:PI_WEBUI_PICKER_CWD;
      try {
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          ConvertTo-Json -Compress -InputObject @($dialog.FileNames);
        } else { '[]' }
      } finally { $dialog.Dispose(); }
    `], { windowsHide: true, env: { ...process.env, PI_WEBUI_PICKER_CWD: cwd } });
    return JSON.parse(stdout);
  }
  try {
    const { stdout } = await exec('zenity', ['--file-selection', '--multiple', '--separator=\n',
      `--filename=${cwd.replace(/\/$/, '')}/`]);
    return stdout.replace(/\n$/, '').split('\n').filter(Boolean);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
}

export async function openFile(url: string): Promise<void> {
  const file = new URL(url);
  if (file.protocol !== 'file:' || file.host) throw new Error('Expected a local file URL');
  const path = fileURLToPath(file);
  await stat(path);
  if (process.platform === 'darwin') {
    await exec('open', [file.href], options);
  } else if (process.platform === 'win32') {
    await exec('explorer.exe', [file.href], options);
  } else {
    await exec('xdg-open', [file.href], options);
  }
}

export async function revealPath(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    await exec('open', ['-R', path], options);
  } else if (process.platform === 'win32') {
    await exec('explorer.exe', [`/select,"${path}"`], { ...options, windowsVerbatimArguments: true }).catch((error) => {
      if (error.code !== 1) throw error;
    });
  } else {
    try {
      await exec('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
        `array:string:${pathToFileURL(path).href.replaceAll(',', '%2C')}`, 'string:'], options);
    } catch {
      await exec('xdg-open', [dirname(path)], options);
    }
  }
}

export async function trashPath(path: string, directory: boolean): Promise<void> {
  if (process.platform === 'darwin') {
    await exec('osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('Foundation');
      function run(args) {
        const error = Ref();
        if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(
          $.NSURL.fileURLWithPath(args[0]), null, error))
          throw Error(ObjC.unwrap(error[0].localizedDescription));
      }
    `, path], options);
  } else if (process.platform === 'win32') {
    const encodedPath = Buffer.from(path).toString('base64');
    const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic;
      $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
      [Microsoft.VisualBasic.FileIO.FileSystem]::${directory ? 'DeleteDirectory' : 'DeleteFile'}(
        $path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], options);
  } else {
    await exec('gio', ['trash', '--', path], options);
  }
}
