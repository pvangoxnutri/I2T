import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES, SECURITY_HEADERS } from '../server/public-files.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
if (dirname(output) !== root || output === root) throw new Error('Invalid build output directory');
// dist is generated exclusively by this script; never copy the entire source tree.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const [relative] of PUBLIC_FILES.values()) {
  const target = join(output, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, relative), target);
}
writeFileSync(join(output, '_headers'), '/*\n' + Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`).join('\n') + '\n');
writeFileSync(join(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2));
console.log('Public website built in dist/. Server code and secrets are excluded.');
