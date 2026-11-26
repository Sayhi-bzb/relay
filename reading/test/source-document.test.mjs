import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { compileCellDocument } from '../src/lib/cell-document.ts';

const markdown = (await readFile(new URL('../src/content/sources/relay-demo.md', import.meta.url), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '');
const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown);
const textOf = node => node.children ? node.children.map(textOf).join('') : node.value ?? '';

test('Cell Markdown preserves all original words, punctuation, and their order', async () => {
  const original = await readFile(new URL('../../processing/cases/relay-demo/article.txt', import.meta.url), 'utf8');
  assert.equal(textOf(tree).replace(/\s/gu, ''), original.replace(/\s/gu, ''));
});

test('Original source compiles through Cell Blog with its headings and quotation', () => {
  const nodes = compileCellDocument(markdown, '/sources/relay-demo/', 'Relay Demo');
  assert.deepEqual(nodes.filter(node => node.kind === 'heading').map(node => node.label), ['Pin a note', 'Browse releases', 'Recover a draft', 'Reuse a link']);
  assert.equal(nodes.filter(node => node.kind === 'quote').length, 1);
  assert.match(nodes[0].source, /Example Release 1.0 lets a reader pin a note/);
  assert.match(nodes.at(-1).source, /share the original source with a teammate/);
});
