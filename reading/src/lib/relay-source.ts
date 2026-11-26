import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { compileCellDocument } from './cell-document.ts';
import type { CellDocumentNode, ImageSizes, RelayUnit } from '../components/cell/model';

type ExportUnit = { id: string; original: string; brief: string; interpretation: string };
export type RelayExport = { source: { title: string; url: string; version: number }; article: ExportUnit; chunks: ExportUnit[] };
type AstNode = { value?: string; children?: AstNode[] };
const textOf = (node: AstNode): string => node.children ? node.children.map(textOf).join('') : node.value ?? '';
const normalized = (text: string) => text.replace(/\s/gu, '');

export function prepareRelay(data: RelayExport, markdown: string, sourceUrl: string, path: string, imageSizes: ImageSizes = {}) {
  const plain = (text: string) => normalized(textOf(unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(text) as AstNode));
  if (data.source.url !== sourceUrl || plain(data.article.original) !== plain(markdown) || normalized(data.chunks.map(chunk => chunk.original).join('')) !== normalized(data.article.original)) throw new Error('Relay source does not match the captured article.');
  const ids = data.chunks.map(chunk => chunk.id);
  if (new Set(ids).size !== ids.length || data.article.id !== 'article') throw new Error('Invalid Relay unit IDs.');
  const original = compileCellDocument(markdown, path, data.source.title, imageSizes);
  const headings = original.filter((node): node is Extract<CellDocumentNode, { kind: 'heading' }> => node.kind === 'heading');
  let headingIndex = 0;
  const unit = (entry: ExportUnit, article = false): RelayUnit => {
    if (!entry.brief.trim() || !entry.interpretation.trim()) throw new Error(`Incomplete Relay unit: ${entry.id}`);
    const nodes = article ? original : compileCellDocument(entry.original, path, entry.id, imageSizes).map(node => {
      if (node.kind !== 'heading') return node;
      const heading = headings[headingIndex++];
      if (!heading || heading.label !== node.label || heading.level !== node.level) throw new Error('Relay heading order does not match the article.');
      return { ...node, id: heading.id };
    });
    const anchors = article ? [] : nodes.flatMap(node => node.kind === 'heading' ? [node.id] : []);
    return { id: entry.id, brief: entry.brief, interpretation: entry.interpretation, originalText: entry.original, original: nodes, anchors };
  };
  return { article: unit(data.article, true), chunks: data.chunks.map(entry => unit(entry)) };
}
