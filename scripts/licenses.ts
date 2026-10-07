import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const seen = new Set<string>();
const packages: {
  name: string;
  version: string;
  license: string;
  notices: string[];
}[] = [];
const piLicense = readFileSync(join(root, 'licenses/pi.txt'), 'utf8');

function scan(modules: string) {
  if (!existsSync(modules)) return;

  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      scan(join(modules, entry));
      continue;
    }

    const path = realpathSync(join(modules, entry));
    if (seen.has(path) || !existsSync(join(path, 'package.json'))) continue;
    seen.add(path);

    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const notices = readdirSync(path)
      .filter((file) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file))
      .map((file) => readFileSync(join(path, file), 'utf8'));
    if (pkg.name.startsWith('@earendil-works/') && pkg.version === '1.0.2')
      notices.push(piLicense);

    packages.push({
      name: pkg.name,
      version: pkg.version,
      license:
        typeof pkg.license === 'string'
          ? pkg.license
          : 'See upstream package',
      notices,
    });
    scan(join(path, 'node_modules'));
  }
}

scan(join(root, 'node_modules'));
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist/THIRD_PARTY_NOTICES.txt'),
  'Third-party packages used by pi-webui. Upstream copyright and license notices are retained below.\n' +
    packages
      .map(
        (pkg) =>
          `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license}\nhttps://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n\n${pkg.notices.join('\n')}`,
      )
      .join('\n'),
);
console.log(`Third-party notices: ${packages.length} packages`);
