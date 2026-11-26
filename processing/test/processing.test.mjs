import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialize, synchronize, updateSource, inspect, exportCase, exportDocument, withWorkspaceLock } from '../scripts/content-store.mjs';
import { editField, processingStatus, readSequence, readUnit, nextTask, writeField } from '../scripts/processing.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'infos processing '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'article workspace'), input = path.join(base, 'input.md');
  await writeFile(input, '# Heading\n\n## First\n\nFirst paragraph.\n\n## Second\n\n第二段。\n');
  await initialize(workspace, input);
  const sourcePath = path.join(workspace, 'source.md'), targetPath = path.join(workspace, 'processed.json');
  return { base, workspace, input, sourcePath, targetPath, source: () => readFile(sourcePath, 'utf8'), target: () => readFile(targetPath, 'utf8') };
}

async function complete(workspace) {
  while (true) {
    const { task } = await nextTask(workspace);
    if (!task) return;
    await writeField(workspace, { ...task, text: `Processed ${task.unit} ${task.field}.` });
  }
}

function cli(f, args, input) {
  const result = spawnSync(path.resolve('bin/relay.mjs'), [...args, '--workspace', f.workspace, '--json'], { input, encoding: 'utf8' });
  assert.equal(result.stderr, '');
  return { ...result, data: JSON.parse(result.stdout) };
}

test('Status derives progress without writing any files', async t => {
  const f = await fixture(t);
  const before = [await f.source(), await f.target()];
  const status = await processingStatus(f.workspace);
  assert.deepEqual(status.totals, { total: 6, done: 0, pending: 6, stale: 0 });
  assert.equal(status.ready, false);
  assert.deepEqual(status.units.map(unit => unit.unit), ['article', 'c0001', 'c0002']);
  assert.deepEqual([await f.source(), await f.target()], before);
  assert.deepEqual((await readdir(f.workspace)).sort(), ['processed.json', 'source.md']);
});

test('Read provides full original text or one chunk, without reserved markers', async t => {
  const f = await fixture(t);
  const article = await readUnit(f.workspace, 'article');
  assert.equal(article.content, '# Heading\n\n## First\n\nFirst paragraph.\n\n## Second\n\n第二段。\n');
  assert.equal(article.version, 1);
  assert.equal((await readUnit(f.workspace, 'c0002')).content, '## Second\n\n第二段。\n');
  const all = await readUnit(f.workspace, 'article', 'all');
  assert.equal(all.brief.state, 'pending');
  assert.equal(all.interpretation.state, 'pending');
  await assert.rejects(readUnit(f.workspace, 'c9999'), { code: 'unknown_unit' });
  await assert.rejects(readUnit(f.workspace, 'article', 'invalid'), { code: 'invalid_view' });
});

test('Sequence reads only chapter drafts in source order and preserves their states and text', async t => {
  const f = await fixture(t);
  await writeField(f.workspace, { unit: 'c0002', field: 'brief', version: 1, text: '第二段\n' });
  await writeField(f.workspace, { unit: 'article', field: 'brief', version: 1, text: 'Full article brief.' });
  const before = await f.target();
  const sequence = cli(f, ['read', '--sequence', '--view', 'brief']);
  assert.equal(sequence.status, 0);
  assert.deepEqual(sequence.data, await readSequence(f.workspace, 'brief'));
  assert.deepEqual(sequence.data.chunks, [
    { unit: 'c0001', state: 'pending', content: '' },
    { unit: 'c0002', state: 'done', content: '第二段\n' },
  ]);
  assert.equal(await f.target(), before);
});

test('Fragment edits preserve surrounding Markdown and reject stale, ambiguous and full replacements', async t => {
  const f = await fixture(t);
  const target = { unit: 'c0001', field: 'interpretation', version: 1 };
  await writeField(f.workspace, { ...target, text: '保留 **粗体**\n\n改这里。\n保留 [链接](#section-second)。\n' });
  const result = cli(f, ['edit', '--unit', target.unit, '--field', target.field, '--version', '1',
    '--before', '改这里。\n', '--after', '加入过渡。\n']);
  assert.equal(result.status, 0);
  assert.deepEqual(result.data.diff, { before: '改这里。\n', after: '加入过渡。\n' });
  const current = (await readUnit(f.workspace, target.unit, target.field)).content;
  assert.equal(current, '保留 **粗体**\n\n加入过渡。\n保留 [链接](#section-second)。\n');
  const before = await f.target();
  for (const [change, code] of [
    [{ before: '改这里。' }, 'edit_conflict'],
    [{ before: '保留' }, 'ambiguous_edit'],
    [{ before: current }, 'whole_field_edit'],
    [{ before: '加入过渡', version: 2 }, 'version_conflict'],
  ]) await assert.rejects(editField(f.workspace, { ...target, after: 'New', ...change }), { code });
  assert.equal(await f.target(), before);
  const deletion = cli(f, ['edit', '--unit', target.unit, '--field', target.field, '--version', '1',
    '--before', '加入过渡。\n', '--after', '']);
  assert.equal(deletion.status, 0);
  assert.equal((await readUnit(f.workspace, target.unit, target.field)).content, '保留 **粗体**\n\n保留 [链接](#section-second)。\n');
});

test('Review injects two scoped turns into one Pi session and publishes only after both pass', async t => {
  const f = await fixture(t);
  await complete(f.workspace);
  const bin = path.join(f.base, 'bin');
  const out = path.join(f.base, 'web.json');
  const turns = path.join(f.base, 'turns.json');
  await mkdir(bin);
  await writeFile(path.join(bin, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(args.at(-1).slice(1), 'utf8');
const turn = { session: args[args.indexOf('--session-id') + 1], cwd: process.cwd(), prompt };
turn.config = process.env.RELAY_CONFIG_FILE;
turn.workspace = JSON.parse(fs.readFileSync(turn.config, 'utf8')).workspace;
turn.record = path.join(args[args.indexOf('--session-dir') + 1], turn.session + '.jsonl');
fs.appendFileSync(turn.record, 'turn\\n');
const turns = fs.existsSync(process.env.RELAY_TEST_TURNS) ? JSON.parse(fs.readFileSync(process.env.RELAY_TEST_TURNS)) : [];
turns.push(turn);
fs.writeFileSync(process.env.RELAY_TEST_TURNS, JSON.stringify(turns));
const second = prompt.includes('上轮简要审阅结果');
const edit = { unit:'c0002', before: 'Processed', after: second ? 'Explained' : 'Connected' };
if (second && process.env.RELAY_TEST_FAIL) edit.unit = 'article';
const content = JSON.stringify({ edits: [edit], findings: [] });
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:content}]}}));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RELAY_TEST_TURNS: turns };
  const run = (extra = {}) => {
    const result = spawnSync(path.resolve('bin/relay.mjs'), ['review', '--workspace', f.workspace, '--out', out, '--json'],
      { env: { ...env, ...extra }, encoding: 'utf8' });
    return { ...result, data: JSON.parse(result.stdout) };
  };
  const original = await f.target();
  await writeFile(out, 'Existing preview');
  assert.equal(run({ RELAY_TEST_FAIL: '1' }).data.errors[0].code, 'invalid_review');
  assert.equal(await f.target(), original);
  assert.equal(await readFile(out, 'utf8'), 'Existing preview');
  await writeFile(turns, '[]');
  const success = run();
  assert.equal(success.status, 0, success.stdout);
  assert.deepEqual(success.data.rounds.map(round => round.view), ['brief', 'interpretation']);
  assert.deepEqual(success.data.rounds[0].edits, [{ unit: 'c0002', before: 'Processed', after: 'Connected' }]);
  const calls = JSON.parse(await readFile(turns, 'utf8'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session, calls[1].session);
  for (const call of calls) {
    assert.equal(call.cwd, path.resolve('.'));
    assert.equal(call.workspace, await realpath(f.workspace));
    assert.equal(call.record, calls[0].record);
    await assert.rejects(readFile(call.config), { code: 'ENOENT' });
  }
  assert.equal(await readFile(calls[0].record, 'utf8'), 'turn\nturn\n');
  assert.match(calls[0].prompt, /Processed c0001 brief/);
  assert.doesNotMatch(calls[0].prompt, /Processed article brief|Processed c0001 interpretation/);
  assert.match(calls[1].prompt, /Processed c0001 interpretation/);
  assert.match(calls[1].prompt, /上轮简要审阅结果[\s\S]*Connected/);
  const published = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(published.article.brief, 'Processed article brief.');
  assert.equal(published.chunks[1].brief, 'Connected c0002 brief.');
  assert.equal(published.chunks[1].interpretation, 'Explained c0002 interpretation.');
  assert.deepEqual(published, await exportDocument(f.workspace));
});

test('Next and write complete a resumable loop for all article and chunk fields', async t => {
  const f = await fixture(t);
  const original = await f.source();
  const first = (await nextTask(f.workspace)).task;
  assert.equal(first.unit, 'article');
  assert.equal(first.field, 'brief');
  assert.match(first.original, /First paragraph/);
  await writeField(f.workspace, { ...first, text: 'Article summary.' });
  const status = await processingStatus(f.workspace);
  assert.equal(status.totals.done, 1);
  assert.equal(status.units[0].interpretation, 'pending');
  assert.equal((await nextTask(f.workspace)).task.field, 'interpretation');
  await complete(f.workspace);
  assert.equal(await f.source(), original);
  assert.equal((await processingStatus(f.workspace)).totals.done, 6);
  assert.deepEqual(await nextTask(f.workspace), { version: 1, ready: true, task: null });
  assert.equal((await inspect(f.workspace)).ok, true);
  const exported = await exportCase(f.workspace, 'article');
  assert.equal(exported.chunk_id, 'article');
  assert.equal(exported.original, (await readUnit(f.workspace, 'article')).content.trim());
  assert.equal(exported.brief, 'Article summary.');
});

test('Each field keeps its own version, and stale submissions cannot overwrite results', async t => {
  const f = await fixture(t);
  await complete(f.workspace);
  await writeFile(f.input, (await f.source()).replace('First paragraph.', 'Updated paragraph.'));
  await updateSource(f.workspace, f.input);
  assert.deepEqual((await processingStatus(f.workspace)).totals, { total: 6, done: 0, pending: 0, stale: 6 });
  const task = (await nextTask(f.workspace, { unit: 'c0001', field: 'brief' })).task;
  assert.equal(task.version, 2);
  assert.equal(task.previous.state, 'stale');
  assert.match(task.original, /Updated paragraph/);
  await writeField(f.workspace, { ...task, text: 'Updated summary.' });
  const status = await processingStatus(f.workspace);
  assert.equal(status.totals.done, 1);
  assert.equal(status.totals.stale, 5);
  assert.equal(status.units.find(unit => unit.unit === 'c0001').interpretation, 'stale');
  assert.equal((await readUnit(f.workspace, 'c0001', 'brief')).source_version, 2);
  const before = await f.target();
  await assert.rejects(writeField(f.workspace, { ...task, version: 1, text: 'Old submission.' }), { code: 'version_conflict' });
  assert.equal(await f.target(), before);
  await assert.rejects(exportCase(f.workspace, 'c0001'), /原文版本变化/);
  await complete(f.workspace);
  assert.equal((await inspect(f.workspace)).ok, true);
});

test('Scoped next only returns matching work, and null does not imply global readiness', async t => {
  const f = await fixture(t);
  const task = (await nextTask(f.workspace, { unit: 'c0002', field: 'interpretation' })).task;
  assert.equal(task.unit, 'c0002');
  assert.equal(task.field, 'interpretation');
  await writeField(f.workspace, { ...task, text: 'Explanation.' });
  assert.deepEqual(await nextTask(f.workspace, { unit: 'c0002', field: 'interpretation' }), { version: 1, ready: false, task: null });
  await assert.rejects(nextTask(f.workspace, { unit: 'c9999' }), { code: 'unknown_unit' });
  await assert.rejects(nextTask(f.workspace, { field: 'title' }), { code: 'invalid_field' });
});

test('Writing a field preserves whitespace and Markdown; repeated identical writes are idempotent', async t => {
  const f = await fixture(t);
  const text = '# A "quote"\n\n```json\n{"brief":"value"}\n```\n\n中文 😀 \\ path\n';
  const options = { unit: 'article', field: 'interpretation', text, version: 1 };
  assert.equal((await writeField(f.workspace, options)).changed, true);
  const before = await f.target();
  assert.equal((await writeField(f.workspace, options)).changed, false);
  assert.equal(await f.target(), before);
  assert.equal((await readUnit(f.workspace, 'article', 'interpretation')).content, text);
});

test('Invalid fields, units, placeholders and future versions fail without changing files', async t => {
  const f = await fixture(t);
  const before = await f.target();
  const options = { unit: 'article', field: 'brief', text: 'Valid content.', version: 1 };
  for (const [patch, code] of [
    [{ field: 'summary' }, 'invalid_field'], [{ unit: 'c9999' }, 'unknown_unit'],
    [{ text: 'TODO' }, 'empty_field'], [{ text: '' }, 'empty_field'],
    [{ version: 0 }, 'invalid_version'], [{ version: 2 }, 'version_conflict'],
  ]) await assert.rejects(writeField(f.workspace, { ...options, ...patch }), { code });
  assert.equal(await f.target(), before);
  assert.deepEqual((await readdir(f.workspace)).sort(), ['processed.json', 'source.md']);
});

test('Sync upgrades legacy string fields without changing source text or processed content', async t => {
  const f = await fixture(t);
  const sourceBefore = await f.source();
  const legacy = { source: 'source.md', source_version: 1, chunks: { c0001: { brief: 'Old brief.', interpretation: 'Old explanation.' }, c0002: { brief: 'Second brief.', interpretation: 'Second explanation.' } } };
  await writeFile(f.targetPath, JSON.stringify(legacy));
  assert.deepEqual((await processingStatus(f.workspace)).totals, { total: 6, done: 4, pending: 2, stale: 0 });
  await synchronize(f.workspace);
  const current = JSON.parse(await f.target());
  assert.equal(current.chunks.c0001.brief.text, legacy.chunks.c0001.brief);
  assert.equal(current.chunks.c0002.interpretation.text, legacy.chunks.c0002.interpretation);
  assert.equal(current.chunks.c0001.brief.source_version, 1);
  assert.equal(current.article.brief.text, '');
  assert.equal(Object.hasOwn(current, 'source_version'), false);
  assert.equal(await f.source(), sourceBefore);
  await writeFile(f.targetPath, JSON.stringify(legacy));
  await writeField(f.workspace, { unit: 'c0001', field: 'brief', text: 'Revised brief.', version: 1 });
  const migratedByWrite = JSON.parse(await f.target());
  assert.equal(migratedByWrite.article.brief.text, '');
  assert.equal(migratedByWrite.chunks.c0001.brief.text, 'Revised brief.');
  assert.equal(migratedByWrite.chunks.c0002.interpretation.text, legacy.chunks.c0002.interpretation);
});

test('All mutations respect one workspace lock, and failed commands release their locks', async t => {
  const f = await fixture(t);
  const before = await f.target();
  await withWorkspaceLock(f.workspace, async () => {
    await assert.rejects(writeField(f.workspace, { unit: 'article', field: 'brief', text: 'Content.', version: 1 }), { code: 'workspace_busy' });
    await assert.rejects(synchronize(f.workspace), { code: 'workspace_busy' });
    await assert.rejects(updateSource(f.workspace, f.input), { code: 'workspace_busy' });
    await assert.rejects(initialize(f.workspace, f.input), { code: 'workspace_busy' });
  });
  assert.equal(await f.target(), before);
  await writeField(f.workspace, { unit: 'article', field: 'brief', text: 'Content.', version: 1 });
  assert.deepEqual((await readdir(f.workspace)).sort(), ['processed.json', 'source.md']);
});

test('CLI reads, writes files and stdin, reports progress, and exports the whole article', async t => {
  const f = await fixture(t);
  const read = cli(f, ['read', '--unit', 'article']);
  assert.equal(read.status, 0);
  assert.equal(read.data.version, 1);
  await writeFile(f.input, 'Brief from a file.\n');
  const write = cli(f, ['write', '--unit', 'article', '--field', 'brief', '--version', '1', '--input', f.input]);
  assert.equal(write.status, 0);
  const explanation = 'Explanation from stdin.\n\n第二段。\n';
  const stdin = cli(f, ['write', '--unit', 'article', '--field', 'interpretation', '--version', '1', '--input', '-'], explanation);
  assert.equal(stdin.status, 0);
  assert.equal((await readUnit(f.workspace, 'article', 'interpretation')).content, explanation);
  const status = cli(f, ['status']);
  assert.equal(status.data.totals.done, 2);
  assert.equal(cli(f, ['next']).data.task.unit, 'c0001');
  await complete(f.workspace);
  const out = path.join(f.base, 'article export.json');
  const exported = cli(f, ['export', '--unit', 'article', '--out', out]);
  assert.equal(exported.status, 0);
  assert.equal(exported.data.chunk_id, 'article');
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), exported.data);
});

test('CLI argument failures are structured JSON with nonzero exit codes', async t => {
  const f = await fixture(t);
  for (const args of [
    ['write', '--unit', 'article', '--field', 'brief', '--version', '1'],
    ['status', '--typo', 'value'], ['read', '--unit', 'article', '--unit', 'c0001'],
    ['unknown'], ['write', '--unit', 'article', '--field', 'brief', '--version', 'oops', '--input', '-'],
  ]) {
    const result = cli(f, args, 'Content.');
    assert.equal(result.status, 1);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.errors[0].code, 'invalid_arguments');
  }
  const before = await f.target();
  const stale = cli(f, ['write', '--unit', 'article', '--field', 'brief', '--version', '2', '--input', '-'], 'Wrong version.');
  assert.equal(stale.status, 1);
  assert.equal(stale.data.errors[0].code, 'version_conflict');
  assert.equal(await f.target(), before);
});

test('Structural problems remain visible and cannot be hidden by processing more fields', async t => {
  const f = await fixture(t);
  const target = JSON.parse(await f.target());
  target.chunks.c9999 = target.chunks.c0001;
  await writeFile(f.targetPath, JSON.stringify(target));
  const status = await processingStatus(f.workspace);
  assert.equal(status.ready, false);
  assert.ok(status.errors.some(error => error.code === 'unknown_chunk'));
  await assert.rejects(nextTask(f.workspace), { code: 'invalid_workspace' });
  await assert.rejects(writeField(f.workspace, { unit: 'article', field: 'brief', text: 'Content.', version: 1 }), { code: 'invalid_workspace' });
});


test('Full-document export includes ordered chunks and rejects incomplete work', async t => {
  const f = await fixture(t);
  await assert.rejects(exportDocument(f.workspace), /完整性检查失败/);
  await complete(f.workspace);
  const document = await exportDocument(f.workspace);
  assert.equal(document.article.id, 'article');
  assert.equal(document.source.version, 1);
  assert.deepEqual(document.chunks.map(chunk => chunk.id), ['c0001', 'c0002']);
  assert.match(document.article.original, /First paragraph/);
  assert.equal(document.chunks[1].original, '## Second\n\n第二段。');
  const result = cli(f, ['export', '--document']);
  assert.equal(result.status, 0);
  assert.deepEqual(result.data, document);
  const conflict = cli(f, ['export', '--document', '--unit', 'article']);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.data.errors[0].code, 'invalid_arguments');
});
