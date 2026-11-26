import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { initialize, rechunk, parseSource, inspect, writeDocument, withWorkspaceLock } from '../scripts/content-store.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'relay-rechunk-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const input = path.join(workspace, 'input.md');
  await writeFile(input, 'Intro.\n\n## First\n\nOne.\n\n### Child\n\nTwo.\n\n## Second\n\nThree.\n');
  await initialize(workspace, input);
  const sourcePath = path.join(workspace, 'source.md'), targetPath = path.join(workspace, 'processed.json');
  const parsed = parseSource(await readFile(sourcePath, 'utf8'));
  const paragraphs = ['Intro.\n\n', '## First\n\nOne.\n\n', '### Child\n\nTwo.\n\n', '## Second\n\nThree.\n'];
  const source = writeDocument({ ...parsed.metadata, next_chunk: 5 }, paragraphs.map((text, i) => `<!-- chunk:c000${i + 1} -->\n${text}<!-- /chunk -->\n`).join(''));
  const unit = { brief: { text: 'Old brief.', source_version: 1 }, interpretation: { text: 'Old interpretation.', source_version: 1 } };
  const target = JSON.stringify({ source: 'source.md', article: unit, chunks: Object.fromEntries(paragraphs.map((_, i) => [`c000${i + 1}`, unit])) });
  await writeFile(sourcePath, source);
  await writeFile(targetPath, target);
  return { workspace, input, sourcePath, targetPath, source, target };
}

test('Rechunk archives paragraph results, allocates new IDs and invalidates article review', async t => {
  const f = await fixture(t);
  const result = JSON.parse(execFileSync(fileURLToPath(new URL('../bin/relay.mjs', import.meta.url)), ['rechunk', '--workspace', f.workspace, '--json'], { encoding: 'utf8' }));
  assert.equal(result.version, 2);
  assert.deepEqual(result.added, ['c0005', 'c0006', 'c0007']);
  assert.equal(await readFile(path.join(result.history, 'source.md'), 'utf8'), f.source);
  assert.equal(await readFile(path.join(result.history, 'processed.json'), 'utf8'), f.target);
  const source = parseSource(await readFile(f.sourcePath, 'utf8'));
  assert.equal(source.text, parseSource(f.source).text);
  assert.equal(source.metadata.next_chunk, 8);
  assert.match(source.chunks[1].text, /### Child/);
  const target = JSON.parse(await readFile(f.targetPath, 'utf8'));
  assert.deepEqual(Object.keys(target.chunks), result.added);
  assert.equal(target.chunks.c0006.brief.text, '');
  assert.equal(target.article.brief.source_version, 1);
  const report = await inspect(f.workspace);
  assert.equal(report.errors.filter(error => error.code === 'stale_source').length, 2);
  assert.equal(report.errors.filter(error => error.code === 'empty_field').length, 6);
  const before = [await readFile(f.sourcePath, 'utf8'), await readFile(f.targetPath, 'utf8')];
  assert.equal((await rechunk(f.workspace)).changed, false);
  assert.deepEqual([await readFile(f.sourcePath, 'utf8'), await readFile(f.targetPath, 'utf8')], before);
  assert.equal((await readdir(path.join(f.workspace, '.history'))).length, 1);
});

test('Rechunk accepts plain Markdown input without inventing sections', async t => {
  const f = await fixture(t);
  await writeFile(f.input, 'A document without headings.\n\nAnother paragraph.\n');
  const result = await rechunk(f.workspace, f.input);
  assert.equal(result.chunks, 1);
  assert.equal(parseSource(await readFile(f.sourcePath, 'utf8')).text, await readFile(f.input, 'utf8'));
});

test('Rechunk refuses malformed workspaces, marked input and concurrent writes', async t => {
  const f = await fixture(t);
  await withWorkspaceLock(f.workspace, () => assert.rejects(rechunk(f.workspace), { code: 'workspace_busy' }));
  await writeFile(f.input, '<!-- chunk:c9999 -->\nBody.\n<!-- /chunk -->\n');
  await assert.rejects(rechunk(f.workspace, f.input), /plain Markdown/);
  await writeFile(f.sourcePath, f.source.replace('chunk:c0002', 'chunk:c0001'));
  await assert.rejects(rechunk(f.workspace), /invalid workspace/);
  assert.equal(await readFile(f.targetPath, 'utf8'), f.target);
  await assert.rejects(readdir(path.join(f.workspace, '.history')), { code: 'ENOENT' });
});
