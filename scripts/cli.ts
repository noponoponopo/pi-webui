import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveRuntime, stateDirectory } from '../server/local-runtime';
import { installBridge } from './install-bridge';
import {
  disableService,
  installLauncher,
  installService,
  startService,
  stopService,
} from './service';

const root = resolve(import.meta.dir, '..');
const [command = 'open', ...args] = process.argv.slice(2);
const help = `pi-webui [open|start|stop|restart|status|serve|setup|disable|pack DIR]
  open     Open the running UI (default); start the macOS service if needed
  start    Start the macOS background service
  stop     Stop the service; --force interrupts active Web sessions, not native CLIs
  restart  Restart the service; --force if a Web session is active
  status   Print the current URL and PID
  serve    Run in the foreground (macOS/Linux)
  setup    Install CLI, Pi bridge and macOS login service; --no-start only installs
  disable  Stop and disable automatic startup
  pack DIR Copy an installable build without credentials or conversation data`;

async function main() {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(help);
      return;
    case 'setup': {
      if (!Bun.which('pi'))
        throw new Error('Install official Pi separately first: https://pi.dev');
      for (const file of ['server.js', 'cli.js', 'pi-webui-extension.js'])
        if (!existsSync(join(root, 'dist', file)))
          throw new Error('Run bun run build first.');
      if (process.platform === 'darwin') await stopService();
      const bin = installLauncher(root);
      const bridge = installBridge(root);
      console.log(`CLI: ${bin}\nPi bridge: ${bridge}`);
      if (process.platform === 'darwin') {
        installService(root);
        if (!args.includes('--no-start'))
          console.log((await startService()).url);
      }
      console.log(
        'Run /reload in existing native CLIs after generation finishes to load bridge updates.',
      );
      return;
    }
    case 'serve':
      await (await import(join(root, 'dist/server.js'))).runServer();
      return;
    case 'status': {
      const runtime = await liveRuntime();
      if (!runtime) {
        console.log('pi-webui is not running');
        process.exitCode = 1;
        return;
      }
      console.log(
        `${runtime.url}\nPID ${runtime.pid}\nData: ${stateDirectory()}`,
      );
      return;
    }
    case 'start':
      console.log((await startService()).url);
      return;
    case 'stop':
      await stopService(args.includes('--force'));
      console.log('pi-webui stopped');
      return;
    case 'disable':
      await disableService(args.includes('--force'));
      console.log('Automatic startup disabled');
      return;
    case 'restart':
      await stopService(args.includes('--force'));
      console.log((await startService()).url);
      return;
    case 'open': {
      const runtime = (await liveRuntime()) ?? (await startService());
      const result = Bun.spawnSync([
        process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open',
        runtime.url,
      ]);
      if (result.exitCode)
        throw new Error(`Could not open the browser. Open ${runtime.url}`);
      console.log(runtime.url);
      return;
    }
    case 'pack': {
      if (args.length !== 1) throw new Error('Usage: pi-webui pack DIR');
      const destination = resolve(args[0]);
      if (existsSync(destination))
        throw new Error(`Destination already exists: ${destination}`);
      if (!existsSync(join(root, 'dist/cli.js')))
        throw new Error('Run bun run build first.');
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const file of ['dist', 'package.json', 'bun.lock', 'README.md', 'install.sh', ...(existsSync(join(root, 'LICENSE')) ? ['LICENSE'] : [])])
        cpSync(join(root, file), join(destination, file), {
          recursive: true,
          errorOnExist: true,
        });
      console.log(
        `Build copied: ${destination}\nOn the destination device: sh install.sh\nCredentials, workspaces and conversation data are not included.`,
      );
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n${help}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
