import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepareRelay } from '../src/lib/relay-source.ts';
import { compileCellDocument } from '../src/lib/cell-document.ts';
import { articleImageStripRows, articleImageStripWidth } from '../src/lib/article-image-strip.ts';
import { changeRelayView, prepareRelayText, relayHeadingTarget, relayInline, relayLinkRegions, relayView } from '../src/lib/relay.ts';
import { prepareCellMorph } from '../src/lib/relay-morph-plan.ts';
import { copyRelayLine } from '../src/lib/relay-layout.ts';
import { layoutMarkdownInlineFlow } from '../src/lib/cell-ui/markdown-inline-flow.ts';
import { walkCellTextRows } from '../src/lib/cell-ui/text-lines.ts';
const exported = JSON.parse(await readFile(new URL('../src/data/relay/relay-demo.json', import.meta.url), 'utf8'));
const markdown = (await readFile(new URL('../src/content/sources/relay-demo.md', import.meta.url), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '');
const prepare = data => prepareRelay(data, markdown, exported.source.url, '/sources/example/');

test('Image strips use a shared height and let image proportions determine how much fits', () => {
  for (const width of [702, 351]) {
    const layout = (sizes) => {
      const height = 20 * articleImageStripRows(width, 20, 9, sizes);
      return sizes.map(size => articleImageStripWidth(width, height, size));
    };
    const landscape = { width: 1600, height: 900 };
    const portrait = { width: 900, height: 1600 };
    const narrow = { width: 300, height: 1000 };
    const total = widths => widths.reduce((sum, item) => sum + item, (widths.length - 1) * 9);
    const wide = layout([landscape, landscape]);
    assert.ok(total(wide) > width && wide[0] < width);
    const mixed = layout([landscape, portrait]);
    assert.equal(mixed[0] / mixed[1], (16 / 9) / (9 / 16));
    assert.ok(total(mixed) <= width);
    const vertical = layout([portrait, portrait]);
    assert.ok(total(vertical) <= width && total(vertical) > width * 0.95);
    assert.ok(vertical[0] > mixed[1]);
    const many = layout(Array(8).fill(narrow));
    assert.ok(total(many.slice(0, 2)) < width && total(many) > width);
    assert.ok(many[0] / 0.3 <= Math.min(600, width * 1.25));
  }
});

test('Relay diagrams hang wrapped text under its branch and preserve link hit regions', () => {
  const source = '├─ [**甲乙丙丁戊己**](#section-example)  \n│　补充甲乙丙丁戊己\n└─ 最后甲乙丙丁戊己\n\n普通段落。';
  const { text, spans } = relayInline(source, 12);
  assert.equal(text, '├─ 甲乙丙丁\n│  戊己\n│　补充甲乙\n│　丙丁戊己\n└─ 最后甲乙\n   丙丁戊己\n\n普通段落。');
  assert.deepEqual(spans.map(({ start, end, bold }) => [text.slice(start, end), bold]),
    [['甲乙丙丁', true], ['戊己', true]]);
  const [[link, boxes]] = relayLinkRegions(source, 12);
  assert.equal(link.href, '#section-example');
  assert.deepEqual(boxes, [{ column: 3, row: 0, width: 8 }, { column: 3, row: 1, width: 4 }]);
});

test('Relay moves whole words to the next row in text, diagrams, links, and morphs', () => {
  const source = '甲乙 [**agent**](#example)\n└─ 甲乙 agent';
  const prepared = prepareRelayText(source, 10);
  assert.equal(prepared.text, '甲乙 agent\n└─ 甲乙\n   agent');
  assert.equal(prepared.rows, 3);
  const narrow = prepareRelayText(source, 8);
  assert.equal(narrow.text, '甲乙\nagent\n└─ 甲乙\n   agent');
  assert.deepEqual([...narrow.links.values()], [[{ column: 0, row: 1, width: 5 }]]);
  const plan = prepareCellMorph(prepareRelayText('agent', 8), narrow);
  assert.deepEqual(plan.to.filter(glyph => glyph.row === 1).map(glyph => [glyph.segment, glyph.column, glyph.style?.bold]),
    [...'agent'].map((letter, column) => [letter, column, true]));
  assert.equal(prepareRelayText('12345 agent', 5).text, '12345\nagent');
  assert.equal(prepareRelayText('12345 中文', 5).text, '12345\n中文');
  assert.equal(prepareRelayText('abcdefghi', 5).text, 'abcde\nfghi');
});

test('Quotes keep their gutter on every Cell row and out of text animations', () => {
  const source = '> abc [**def ghi**](#example)\ncontinuation\n>\n> > nested\n\nplain';
  const prepared = prepareRelayText(source, 10);
  assert.equal(prepared.text, '│ abc def\n│ ghi\n│ continua\n│ tion\n│ \n│ │ nested\n\nplain');
  assert.deepEqual([...prepared.links.values()], [[{ column: 6, row: 0, width: 3 }, { column: 2, row: 1, width: 3 }]]);
  const plan = prepareCellMorph(prepareRelayText('def', 10), prepared);
  assert.ok(plan.to.every(glyph => glyph.segment !== '│'));
  assert.deepEqual(plan.to.filter(glyph => glyph.row === 1).map(glyph => [glyph.segment, glyph.column, glyph.style?.bold]),
    [...'ghi'].map((letter, index) => [letter, index + 2, true]));
  assert.equal(prepareRelayText('>\n\nplain', 10).text, '│ \n\nplain');
  assert.equal(prepareRelayText('> - abc def\n>   - xyz uv', 9).text, '│ • abc\n│   def\n│   • xyz\n│     uv');
});

test('Logical copying joins soft rows and retains explicit breaks and authored diagram guides', () => {
  const source = '> abc [def  ghi](#example)\nsecond\n\n╰─ alpha beta\n\n甲乙，丙';
  for (const width of [8, 12, 24, 32, 48, 72]) {
    const prepared = prepareRelayText(source, width);
    const copied = prepared.copyLines.map((line, index) =>
      copyRelayLine(line, 0, width - 1) + (index < prepared.rows - 1 ? line.after : '')).join('');
    assert.equal(copied, 'abc def  ghi\nsecond\n\n╰─ alpha beta\n\n甲乙，丙');
    const painted = [];
    walkCellTextRows(prepared.text, width, glyph => { painted.push(glyph); });
    assert.deepEqual(prepared.glyphs.map(({ row, column, segment }) => ({ row, column, segment })),
      painted.map(({ row, column, segment }) => ({ row, column, segment })));
  }
  assert.equal(prepareRelayText('╰─ abc def', 8).text, '╰─ abc\n   def');
  assert.equal(copyRelayLine(prepareRelayText('　　├─ abc', 3).copyLines[0], 0, 2), '　　├─');
  assert.equal(copyRelayLine(prepareRelayText('> abc', 8).copyLines[0], 0, 1), '');
  assert.equal(copyRelayLine(prepareRelayText('> abc', 8).copyLines[0], 3, 4), 'bc');
});

test('Relay and original Markdown share word and punctuation break rules', () => {
  const text = '甲乙，丙';
  const original = layoutMarkdownInlineFlow([{ text, style: {} }], 4);
  const relay = prepareRelayText(text, 4);
  assert.equal(relay.text, '甲\n乙，\n丙');
  assert.deepEqual(relay.glyphs.map(({ segment, row, column }) => [segment, row, column]),
    original.glyphs.map(({ text, y, x }) => [text, y, x]));
  assert.equal(prepareRelayText('agent，朋友', 5).text.split('\n')[0], 'agent');
});

test('The actual article and all 5 sections are connected to existing Relay views', () => {
  const document = prepare(exported);
  assert.equal(document.article.id, 'article');
  assert.equal(document.chunks.length, 5);
  assert.deepEqual(document.chunks.map(unit => unit.id), exported.chunks.map(unit => unit.id));
  assert.equal(document.chunks.filter(unit => unit.anchors.length).length, 4);
  assert.equal(document.article.original.filter(node => node.kind === 'heading').length, 4);
  assert.match(document.article.interpretation, /├─/);
});

test('Wrong sources, missing chunks, duplicate IDs and incomplete views fail before publication', () => {
  for (const mutate of [
    data => { data.source.url = 'https://example.com/wrong'; },
    data => { data.article.original = 'Different article'; },
    data => { data.chunks.pop(); },
    data => { data.chunks[1].id = data.chunks[0].id; },
    data => { data.chunks[0].brief = ''; },
  ]) {
    const data = structuredClone(exported);
    mutate(data);
    assert.throws(() => prepare(data));
  }
});

test('Each item keeps its own mode and returns from original to the prior reading view', () => {
  let views = changeRelayView({}, 'c0012', 'toggle');
  assert.equal(relayView(views, 'c0012').mode, 'interpretation');
  assert.equal(relayView(views, 'c0001').mode, 'brief');
  assert.equal(relayView(views, 'article').mode, 'brief');
  views = changeRelayView(views, 'c0012', 'original');
  assert.equal(relayView(views, 'c0012').mode, 'original');
  assert.equal(changeRelayView(views, 'c0012', 'toggle'), views);
  views = changeRelayView(views, 'c0001', 'toggle');
  views = changeRelayView(views, 'c0012', 'original');
  assert.equal(relayView(views, 'c0012').mode, 'interpretation');
  assert.equal(relayView(views, 'c0001').mode, 'interpretation');
  views = changeRelayView(views, 'c0012', 'toggle');
  assert.equal(relayView(views, 'c0012').mode, 'brief');
});

test('Relay morph inherits styled characters and emoji across Cell rows in both directions', () => {
  const from = prepareRelayText('**甲** A👩‍💻\nB', 6);
  const to = prepareRelayText('B新\n**甲**👩‍💻A', 6);
  const plan = prepareCellMorph(from, to);
  assert.equal(to.rows, 2);
  assert.deepEqual(plan.to.map(({ segment, row, column }) => [segment, row, column]), [
    ['B', 0, 0], ['新', 0, 1], ['甲', 1, 0], ['👩‍💻', 1, 2], ['A', 1, 4],
  ]);
  assert.deepEqual(plan.origins.map(index => plan.from[index]?.segment), ['B', undefined, '甲', '👩‍💻', 'A']);
  assert.equal(plan.to[2].style.bold, true);
  assert.equal(plan.from[plan.origins[3]].row, 0);
  assert.equal(plan.to[3].width, 2);
  const reverse = prepareCellMorph(to, from);
  plan.origins.forEach((origin, index) => {
    if (origin !== undefined) assert.equal(reverse.origins[origin], index);
  });
  assert.equal(prepareCellMorph(from, to), plan);
});

test('Nested and repeated headings retain article anchors in section and full originals', () => {
  const sections = ['Intro.\n\n', '## First\n\nOne.\n\n### Repeated\n\nTwo.\n\n', '## Second\n\n### Repeated\n\nThree.\n'];
  const unit = (id, original) => ({ id, original, brief: 'Brief.', interpretation: 'Interpretation.' });
  const data = { source: { title: 'Example', url: 'https://example.com', version: 1 }, article: unit('article', sections.join('')), chunks: sections.map((text, i) => unit(`c000${i + 1}`, text)) };
  const document = prepareRelay(data, sections.join(''), data.source.url, '/example/');
  assert.deepEqual(document.chunks.map(unit => unit.anchors), [[], ['section-first', 'section-repeated'], ['section-second', 'section-repeated-2']]);
  assert.equal(relayHeadingTarget(document, {}, 'section-repeated-2'), 'relay-item:c0003');
  const views = changeRelayView({}, 'c0003', 'original');
  assert.equal(relayHeadingTarget(document, views, 'section-repeated-2'), 'relay-original-c0003-1-section-repeated-2');
  assert.equal(relayHeadingTarget(document, changeRelayView(views, 'article', 'original'), 'section-repeated-2'), 'relay-original-article-6-section-repeated-2');
});

test('Image positions, captions and dimensions survive Relay capture and chapter boundaries', () => {
  const source = 'Intro.\n\n## A gallery\n\nFirst.\n\n![One](https://example.com/one.png "First image")\n\n![Two](https://example.com/two.png "Second image")\n';
  const heading = source.indexOf('## A gallery');
  const images = { 'https://example.com/one.png': { width: 1600, height: 900 }, 'https://example.com/two.png': { width: 600, height: 800 } };
  const unit = (id, original) => ({ id, original, brief: 'Brief.', interpretation: 'Interpretation.' });
  const data = { source: { title: 'Gallery', url: 'https://example.com/gallery', version: 1 },
    article: unit('article', source), chunks: [unit('c0001', source.slice(0, heading)), unit('c0002', source.slice(heading))] };
  const document = prepareRelay(data, source, data.source.url, '/gallery/', images);
  const imageNodes = item => item.original.filter(node => node.kind === 'image');
  assert.equal(imageNodes(document.article).length, 2);
  assert.deepEqual(document.chunks.flatMap(imageNodes), imageNodes(document.article));
  const [first] = imageNodes(document.chunks[1]);
  assert.equal(first.caption, 'First image');
  assert.deepEqual(first.size, { width: 1600, height: 900 });
  assert.ok(document.chunks[1].original.findIndex(node => node.kind === 'image') > 1);
});

test('Images inside paragraphs occupy their own slot between text fragments', () => {
  const nodes = compileCellDocument('Before ![Floor plan](/assets/plan.png "First floor") after.\n\n![Unsafe](javascript:bad)', '/sources/test/', 'test');
  assert.deepEqual(nodes.map(node => node.kind), ['markdown', 'image', 'markdown', 'markdown']);
  assert.deepEqual(nodes.map(node => node.source ?? node.caption), ['Before', 'First floor', 'after.', 'Unsafe']);
});
