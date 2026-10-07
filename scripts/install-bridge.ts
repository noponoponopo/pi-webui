import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function installBridge(root = resolve(import.meta.dir, '..')) {
  const extension = join(root, 'dist/pi-webui-extension.js');
  if (!existsSync(extension))
    throw new Error('Run bun run build before installing the bridge.');
  const directory = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'),
    'extensions',
  );
  const target = join(directory, 'pi-webui.ts');
  const content = `// pi-webui managed bridge\nexport { default } from ${JSON.stringify(extension)};\n`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (
      !existing.startsWith('// pi-webui managed bridge\n') &&
      existing !== `export { default } from ${JSON.stringify(extension)};\n`
    )
      throw new Error(`Refusing to overwrite existing extension: ${target}`);
  }
  writeFileSync(target, content, { mode: 0o600 });
  return target;
}

if (import.meta.main)
  console.log(
    `Pi bridge installed: ${installBridge()}\nRun /reload in existing CLI sessions to connect them.`,
  );
