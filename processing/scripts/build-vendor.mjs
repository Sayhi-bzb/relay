import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = new URL('../vendor/', import.meta.url);
await mkdir(vendor, { recursive: true });
const pkg = JSON.parse(await readFile(new URL('../node_modules/torph/package.json', import.meta.url), 'utf8'));
await build({
  absWorkingDir: root,
  entryPoints: ['torph'],
  outfile: fileURLToPath(new URL('torph.js', vendor)),
  bundle: true,
  format: 'iife',
  globalName: 'Torph',
  minify: true,
  legalComments: 'inline',
  banner: { js: `/* Torph ${pkg.version} | Lochie Axon | MIT | See TORPH-LICENSE.txt */` },
});
await copyFile(new URL('../node_modules/torph/LICENSE', import.meta.url), new URL('TORPH-LICENSE.txt', vendor));
console.log(`Bundled Torph ${pkg.version} for offline use.`);
