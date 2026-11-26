import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialize, synchronize, updateSource, inspect, exportCase, splitMarkdown, parseSource, parseTarget, readDocument, writeDocument, writeTarget, validate, SOURCE_FILE, TARGET_FILE } from '../scripts/content-store.mjs';

async function fixture(t, text = '## First\n\n第一段。\n\n## Second\n\n第二段。\n') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'infos-content-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const input = path.join(base, 'input.md'), workspace = path.join(base, 'article');
  await writeFile(input, text);
  await initialize(workspace, input, { title: '测试', url: 'https://example.com/article' });
  const sourcePath = path.join(workspace, SOURCE_FILE), targetPath = path.join(workspace, TARGET_FILE);
  const target = JSON.parse(await readFile(targetPath, 'utf8'));
  const completed = () => ({ brief: { text: '已完成的内容。', source_version: 1 }, interpretation: { text: '已完成的内容。', source_version: 1 } });
  for (const id of Object.keys(target.chunks)) target.chunks[id] = completed();
  target.article = completed();
  await writeFile(targetPath, JSON.stringify(target));
  return { workspace, input, sourcePath, targetPath, source: () => readFile(sourcePath, 'utf8'), target: () => readFile(targetPath, 'utf8') };
}

const codes = result => result.errors.map(error => error.code);
const wrapChunk = chunk => `<!-- chunk:${chunk.id} -->\n${chunk.text}<!-- /chunk -->\n`;
async function submit(f, body) {
  const input = path.join(path.dirname(f.input), 'edited source.md');
  await writeFile(input, body);
  return updateSource(f.workspace, input);
}

test('H2 sections preserve Intro, nested content and source bytes', () => {
  const sections = ['# Title\n\nIntro.\n\n', '## First\n\nOne.\n\n### Nested\n\nTwo.\n\n```md\n## Not a section\n```\n\n> ## Quoted\n\n', '## Second\n\n- A\n- B\n'];
  assert.deepEqual(splitMarkdown(sections.join('')), sections);
  assert.deepEqual(splitMarkdown('One.\n\nTwo.\n'), ['One.\n\nTwo.\n']);
  assert.deepEqual(splitMarkdown('# Title\n\n## First\n\nBody.\n'), ['# Title\n\n## First\n\nBody.\n']);
  assert.deepEqual(splitMarkdown(''), []);
});

test('JSON results export by ID in source order, independently of object order', async t => {
  const f = await fixture(t);
  const target = parseTarget(await f.target());
  await writeFile(f.targetPath, writeTarget(target.metadata, target.chunks.toReversed(), target.article));
  const result = await inspect(f.workspace);
  assert.equal(result.ok, true);
  assert.equal(result.source_chunks, 2);
  assert.equal(result.version, 1);
  assert.equal((await exportCase(f.workspace)).chunk_id, 'c0001');
  const output = await exportCase(f.workspace, 'c0002');
  assert.equal(output.original, '## Second\n\n第二段。');
  assert.equal(output.brief, '已完成的内容。');
  assert.equal(output.chunk_id, 'c0002');
});

test('Initialization never overwrites an existing workspace', async t => {
  const f = await fixture(t);
  const before = await f.target();
  await assert.rejects(initialize(f.workspace, f.input), /不会覆盖/);
  assert.equal(await f.target(), before);
});

test('Duplicate source IDs and duplicate JSON keys are rejected before writes', async t => {
  const f = await fixture(t);
  const sourceText = await f.source(), targetText = await f.target();
  const source = parseSource(sourceText);
  const duplicateSource = sourceText + wrapChunk(source.chunks[0]);
  assert.ok(codes(validate(duplicateSource, targetText)).includes('duplicate_source_id'));
  await assert.rejects(submit(f, duplicateSource), /ID 重复/);
  assert.equal(await f.source(), sourceText);
  assert.equal(await f.target(), targetText);
  const duplicateTargets = [
    targetText.replace('"chunks":{', '"chunks":{"c0001":{},'),
    targetText.replace('"brief":', '"brief":"first","brief":'),
    targetText.replace('"brief":', '"br\\u0069ef":"first","brief":'),
    targetText.replace('"source_version":1', '"source_version":1,"source_version":1')
  ];
  for (const text of duplicateTargets) {
    assert.ok(codes(validate(sourceText, text)).includes('invalid_target'));
    await writeFile(f.targetPath, text);
    await assert.rejects(synchronize(f.workspace), /重复 JSON key/);
    assert.equal(await f.target(), text);
    assert.equal(await f.source(), sourceText);
  }
});

test('Missing IDs, extra references, and incorrect source filenames fail validation', async t => {
  const f = await fixture(t);
  const source = await f.source(), target = parseTarget(await f.target());
  assert.ok(codes(validate(source, writeTarget(target.metadata, target.chunks.slice(0, 1), target.article))).includes('missing_chunk'));
  const unknown = structuredClone(target.chunks);
  unknown[1].id = 'c9999';
  assert.ok(codes(validate(source, writeTarget(target.metadata, unknown, target.article))).includes('unknown_chunk'));
  assert.ok(codes(validate(source, writeTarget({ ...target.metadata, source: 'other.md' }, target.chunks, target.article))).includes('invalid_reference'));
});

test('Missing fields, placeholders, incorrect types, and unknown fields fail validation', async t => {
  const f = await fixture(t);
  const source = await f.source(), data = JSON.parse(await f.target());
  delete data.chunks.c0001.brief;
  assert.ok(codes(validate(source, JSON.stringify(data))).includes('missing_field'));
  for (const value of ['', '<!-- TODO -->', 'TODO', 'TBD', '...', '…', '待填写']) {
    data.chunks.c0001.brief = { text: value, source_version: 1 };
    assert.ok(codes(validate(source, JSON.stringify(data))).includes('empty_field'), value);
  }
  for (const value of [null, 1, [], {}]) {
    data.chunks.c0001.brief = value;
    assert.ok(codes(validate(source, JSON.stringify(data))).includes('invalid_target'));
  }
  data.chunks.c0001.brief = { text: 'complete', source_version: 1 };
  data.chunks.c0001.extra = 'unknown';
  assert.ok(codes(validate(source, JSON.stringify(data))).includes('invalid_target'));
  delete data.chunks.c0001.extra;
  for (const value of [[], null, 'text']) {
    assert.ok(codes(validate(source, JSON.stringify({ ...data, chunks: value }))).includes('invalid_target'));
  }
});

test('Versions must be positive safe integers on both sides', async t => {
  const f = await fixture(t);
  const { metadata, body } = readDocument(await f.source());
  const target = JSON.parse(await f.target());
  for (const version of [undefined, 0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    const sourceMetadata = { ...metadata, version };
    if (version === undefined) delete sourceMetadata.version;
    assert.ok(codes(validate(writeDocument(sourceMetadata, body), JSON.stringify(target))).includes('invalid_version'));
    target.chunks.c0001.brief.source_version = version;
    assert.ok(codes(validate(await f.source(), JSON.stringify(target))).includes('invalid_source_version'));
  }
});

test('Updating source increments version and blocks export until processing is reviewed', async t => {
  const f = await fixture(t);
  const originalTarget = await f.target();
  const result = await submit(f, (await f.source()).replace('第一段。', '更新后的第一段。'));
  assert.equal(result.version, 2);
  assert.equal(result.source_changed, true);
  assert.deepEqual(JSON.parse(await f.target()), JSON.parse(originalTarget));
  const changed = await f.source();
  assert.ok(codes(await inspect(f.workspace)).includes('stale_source'));
  assert.equal(await f.source(), changed);
  await assert.rejects(exportCase(f.workspace, 'c0002'), /原文版本变化/);
  const reviewed = JSON.parse(await f.target());
  reviewed.chunks.c0001.brief.text = '已复核的新内容。';
  for (const unit of [reviewed.article, ...Object.values(reviewed.chunks)]) for (const field of Object.values(unit)) field.source_version = 2;
  await writeFile(f.targetPath, JSON.stringify(reviewed));
  assert.equal((await inspect(f.workspace)).ok, true);
});

test('No-op update and repeated sync leave version and files unchanged', async t => {
  const f = await fixture(t);
  assert.equal((await submit(f, await f.source())).version, 1);
  await synchronize(f.workspace);
  const source = await f.source(), target = await f.target();
  const result = await synchronize(f.workspace);
  assert.equal(result.version, 1);
  assert.equal(result.source_changed, false);
  assert.equal(await f.source(), source);
  assert.equal(await f.target(), target);
});

test('Inserting new source assigns new IDs and preserves existing processed values', async t => {
  const f = await fixture(t);
  const { metadata, body } = readDocument(await f.source()), previous = parseTarget(await f.target());
  const first = await submit(f, writeDocument(metadata, '新插入的段落。\n\n' + body));
  assert.deepEqual(first.added, ['c0003']);
  assert.equal(first.version, 2);
  const source = parseSource(await f.source()), target = parseTarget(await f.target());
  assert.deepEqual(source.chunks.map(chunk => chunk.id), ['c0003', 'c0001', 'c0002']);
  for (const chunk of previous.chunks) assert.deepEqual(target.chunks.find(item => item.id === chunk.id).values, chunk.values);
  const errors = codes(await inspect(f.workspace));
  assert.ok(errors.includes('empty_field') && errors.includes('stale_source'));
});

test('Reordering keeps IDs; deletion preserves orphaned results; new IDs are not recycled', async t => {
  const f = await fixture(t);
  let source = parseSource(await f.source());
  await submit(f, writeDocument(source.metadata, source.chunks.toReversed().map(wrapChunk).join('')));
  source = parseSource(await f.source());
  assert.deepEqual(source.chunks.map(chunk => chunk.id), ['c0002', 'c0001']);
  const kept = source.chunks.find(chunk => chunk.id === 'c0001');
  const result = await submit(f, writeDocument(source.metadata, wrapChunk(kept) + '新的内容。\n'));
  assert.deepEqual(result.added, ['c0003']);
  assert.deepEqual(result.orphaned_preserved, ['c0002']);
  assert.ok(codes(await inspect(f.workspace)).includes('unknown_chunk'));
});

test('Markdown headings, fences, quotes and escaped text remain ordinary JSON string content', async t => {
  const f = await fixture(t, '```md\n<!-- chunk:c7777 -->\n## c9999\n### brief\n```\n\n普通段落。\n');
  assert.equal(parseSource(await f.source()).chunks.length, 1);
  const target = JSON.parse(await f.target());
  const text = '# Heading\n\n```json\n{"brief": "value", "chunks": {}}\n```\n\nA \\ path, "quote", 😀 and **Markdown**.';
  target.chunks.c0001.interpretation.text = text;
  await writeFile(f.targetPath, JSON.stringify(target));
  assert.equal((await inspect(f.workspace)).ok, true);
  assert.deepEqual((await exportCase(f.workspace, 'c0001')).interpretation, text.split(/\n\s*\n/));
});

test('Any unfinished chunk blocks export, including chunks not selected for preview', async t => {
  const f = await fixture(t);
  const target = JSON.parse(await f.target());
  target.chunks.c0002.brief.text = '';
  await writeFile(f.targetPath, JSON.stringify(target));
  await assert.rejects(exportCase(f.workspace, 'c0001'), /未填写/);
});

test('Update rejects overwritten originals, stale copies and malformed input without writing', async t => {
  const f = await fixture(t);
  const source = await f.source(), target = await f.target();
  await assert.rejects(updateSource(f.workspace, f.sourcePath), /编辑副本/);
  const { metadata, body } = readDocument(source);
  await assert.rejects(submit(f, writeDocument({ ...metadata, version: 2 }, body)), /最新 source.md/);
  await assert.rejects(submit(f, 'invalid markdown document'), /元数据/);
  assert.equal(await f.source(), source);
  assert.equal(await f.target(), target);
});

test('CLI update accepts an edited copy and reports the incremented version', async t => {
  const f = await fixture(t);
  await writeFile(f.input, (await f.source()).replace('第一段。', 'CLI 更新后的第一段。'));
  const result = JSON.parse(execFileSync(path.resolve('bin/relay.mjs'), ['update', '--workspace', f.workspace, '--input', f.input, '--json'], { encoding: 'utf8' }));
  assert.equal(result.version, 2);
  assert.ok(codes(await inspect(f.workspace)).includes('stale_source'));
});
