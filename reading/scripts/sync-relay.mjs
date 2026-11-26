import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const processing = new URL('../../processing/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('./source-catalog.json', import.meta.url), 'utf8'));
const directory = new URL('../src/data/relay/', import.meta.url);
await mkdir(directory, { recursive: true });
const articles = {};
for (const { workspace } of catalog) {
  const data = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('bin/relay.mjs', processing)),
    'export', '--document', '--workspace', fileURLToPath(new URL(`content/${workspace}`, processing)), '--json'],
  { encoding: 'utf8' }));
  if (articles[data.source.url]) throw new Error(`Duplicate Relay source: ${data.source.url}`);
  articles[data.source.url] = data;
  await writeFile(new URL(`${workspace}.json`, directory), JSON.stringify(data, null, 2) + '\n');
  console.log(`Exported ${workspace}: article and ${data.chunks.length} chunks.`);
}
await writeFile(new URL('index.json', directory), JSON.stringify(articles, null, 2) + '\n');
