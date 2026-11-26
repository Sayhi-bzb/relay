import { Lexer, type Token, type Tokens } from 'marked';
import { getGraphemeCellWidth, getTextCellWidth, iterateGraphemes } from '@chardesk/protocol';
import { layoutInlineLines } from './cell-ui/inline-line-breaks.ts';
import { safeMarkdownHref } from './cell-ui/markdown.ts';

type RelayLink = Readonly<{ href: string; label: string }>;
export type RelayInlineStyle = Readonly<{ bold?: boolean; code?: boolean; quote?: boolean; link?: RelayLink }>;
type RelayInlineSpan = RelayInlineStyle & { start: number; end: number };
type Ink = Readonly<{ text: string; width: 1 | 2; offset: number; style?: RelayInlineStyle }>;
type Context = Readonly<{ quote: number; indent: number }>;
type LogicalLine = {
  text: string;
  spans: RelayInlineSpan[];
  context?: Context;
  marker?: { indent: number; text: string };
};
type CopyCell = Readonly<{ column: number; width: number; start: number; end: number }>;
export type RelayCopyLine = Readonly<{ source: string; cells: readonly CopyCell[]; after: string; firstRow: boolean }>;
export type RelayGlyph = Readonly<{
  segment: string; width: 1 | 2; row: number; column: number; offset: number;
  style?: RelayInlineStyle; decoration?: boolean;
}>;

const root: Context = { quote: 0, indent: 0 };
const diagramBranch = /^([ │┃　]*)([├└┌╭╰┣┗┏])[─━]+[ 　]*/u;
const diagramIndent = /^[ │┃　]+/u;
const continueBranch = /^[├┌╭┣┏]$/u;
const trailingNewlines = (text: string) => /\n+$/u.exec(text)?.[0].length ?? 0;
const parsedSources = new Map<string, LogicalLine[]>();

function parseRelayLines(source: string): LogicalLine[] {
  const cached = parsedSources.get(source);
  if (cached) return cached;
  const lines: LogicalLine[] = [{ text: '', spans: [] }];
  const current = () => lines[lines.length - 1]!;
  const trailing = () => {
    let index = lines.length - 1;
    while (index > 0 && !lines[index]!.text && !lines[index]!.marker) index--;
    return lines.length - 1 - index;
  };

  const write = (text: string, context: Context, style?: RelayInlineStyle) => {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push({ text: '', spans: [] });
      const part = parts[i]!;
      const line = current();
      if (!line.text && part) line.context = context;
      else if (i < parts.length - 1) line.context ??= context;
      const start = line.text.length;
      line.text += part;
      if (style && part) line.spans.push({ ...style, start, end: line.text.length });
    }
  };

  const inline = (tokens: readonly Token[], context: Context, style?: RelayInlineStyle) => {
    for (const token of tokens) {
      if (token.type === 'strong') { inline(token.tokens ?? [], context, { ...style, bold: true }); continue; }
      if (token.type === 'codespan') { write(token.text, context, { ...style, code: true }); continue; }
      if (token.type === 'br') { write('\n', context, style); continue; }
      if (token.type === 'link' && token.raw.startsWith('[')) {
        const href = safeMarkdownHref(token.href);
        if (href) { inline(token.tokens ?? [], context, { ...style, link: { href, label: token.text } }); continue; }
      }
      write(token.raw, context, style);
    }
  };

  const addTrailing = (raw: string, context: Context, minimum = 0) => {
    const count = Math.max(minimum, trailingNewlines(raw)) - trailing();
    if (count > 0) write('\n'.repeat(count), context);
  };

  const blocks = (tokens: readonly Token[], context: Context) => {
    let plain = '';
    const flush = () => {
      if (!plain) return;
      inline(Lexer.lexInline(plain), context);
      plain = '';
    };
    for (const token of tokens) {
      if (token.type === 'blockquote') {
        flush();
        const quote = { ...context, quote: context.quote + 1 };
        current().context = quote;
        const initialLine = lines.length;
        blocks(token.tokens ?? [], quote);
        if (!current().text) current().context ??= quote;
        const extra = (token.raw.match(/\n/gu)?.length ?? 0) - (lines.length - initialLine);
        if (extra > 0) write('\n'.repeat(extra), context);
      } else if (token.type === 'list') {
        flush();
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          if (current().marker || current().text) write('\n', context);
          const text = item.task ? (item.checked ? '☑ ' : '☐ ')
            : list.ordered ? `${Number(list.start) + index}. ` : '• ';
          const itemContext = { ...context, indent: context.indent + getTextCellWidth(text) };
          current().context = itemContext;
          current().marker = { indent: context.indent, text };
          blocks(item.tokens ?? [], itemContext);
          if (index < list.items.length - 1) addTrailing(item.raw, itemContext, 1);
        });
        addTrailing(token.raw, context);
      } else {
        plain += token.raw;
      }
    }
    flush();
  };
  blocks(Lexer.lex(source), root);
  if (parsedSources.size >= 160) parsedSources.delete(parsedSources.keys().next().value!);
  parsedSources.set(source, lines);
  return lines;
}

function cellsFor(text: string, start = 0, spans: readonly RelayInlineSpan[] = []): Ink[] {
  let index = 0;
  return Array.from(iterateGraphemes(text), ({ index: position, segment }) => {
    const offset = start + position;
    while (spans[index] && spans[index]!.end <= offset) index++;
    const span = spans[index];
    return { text: segment, offset, width: getGraphemeCellWidth(segment),
      style: span && span.start <= offset ? span : undefined };
  });
}

export function layoutRelay(source: string, width = Number.POSITIVE_INFINITY) {
  const limit = Math.max(1, Math.floor(width));
  const glyphs: RelayGlyph[] = [];
  const spans: RelayInlineSpan[] = [];
  const copyLines: RelayCopyLine[] = [];
  const links = new Map<RelayLink, { column: number; row: number; width: number }[]>();
  const displayLines: string[] = [];
  let displayOffset = 0;
  let inDiagram = false;

  for (const { text, spans: inline, context = root, marker } of parseRelayLines(source)) {
    const prefix = diagramBranch.exec(text);
    const indent: string | undefined = prefix?.[0] ?? (inDiagram ? diagramIndent.exec(text)?.[0] : undefined);
    inDiagram = Boolean(indent && indent.length < text.length);
    const quote = '│ '.repeat(context.quote);
    const list = marker ? ' '.repeat(marker.indent) + marker.text : ' '.repeat(context.indent);
    const leading = (quote + list).slice(0, Math.max(0, limit - 2));
    const hanging = (quote + ' '.repeat(context.indent)).slice(0, Math.max(0, limit - 2));
    const columns = getTextCellWidth(hanging);
    const indentWidth = getTextCellWidth(indent ?? '');
    const diagram = inDiagram && limit - columns - indentWidth >= 2 ? indent! : '';
    const guide = prefix ? prefix[1]! + (continueBranch.test(prefix[2]!) ? (prefix[2] === '┣' || prefix[2] === '┏' ? '┃' : '│') : ' ') : diagram;
    const continuation = diagram ? guide + ' '.repeat(indentWidth - getTextCellWidth(guide)) : '';
    const ink = cellsFor(text.slice(diagram.length), diagram.length, inline);
    const rows = layoutInlineLines(ink, limit - columns - getTextCellWidth(diagram), true);
    const firstDiagram = cellsFor(diagram, 0, inline);
    const nextDiagram = cellsFor(continuation);
    const firstPrefix = cellsFor(leading);
    const nextPrefix = leading === hanging ? firstPrefix : cellsFor(hanging);
    const quoteStyle: RelayInlineStyle | undefined = context.quote ? { quote: true } : undefined;

    for (const [index, { start, end }] of rows.entries()) {
      const row = displayLines.length;
      const copies: CopyCell[] = [];
      let line = '';
      let column = 0;
      const paint = (cell: Ink, decoration = false, copy = true) => {
        if (column + cell.width > limit) return;
        const offset = displayOffset + line.length;
        const style = cell.style && quoteStyle ? { ...cell.style, ...quoteStyle } : cell.style ?? quoteStyle;
        glyphs.push({ segment: cell.text, width: cell.width, row, column, offset, style, decoration });
        if (copy) copies.push({ column, width: cell.width, start: cell.offset, end: cell.offset + cell.text.length });
        if (style) {
          const last = spans.at(-1);
          if (last?.end === offset && last.bold === style.bold && last.code === style.code
            && last.link === style.link && last.quote === style.quote) last.end += cell.text.length;
          else spans.push({ ...style, start: offset, end: offset + cell.text.length });
          if (!decoration && style.link) {
            const boxes = links.get(style.link) ?? [];
            const previous = boxes.at(-1);
            if (previous?.row === row && previous.column + previous.width === column) previous.width += cell.width;
            else boxes.push({ column, row, width: cell.width });
            links.set(style.link, boxes);
          }
        }
        line += cell.text;
        column += cell.width;
      };
      for (const cell of index === 0 ? firstPrefix : nextPrefix) paint(cell, true, false);
      for (const cell of index === 0 ? firstDiagram : nextDiagram) paint(cell, true, index === 0);
      for (let i = start; i < end; i++) paint(ink[i]!);
      const next = rows[index + 1];
      const after = next ? text.slice(copies.at(-1)?.end ?? 0, ink[next.start]?.offset ?? text.length) : '\n';
      copyLines.push({ source: text, cells: copies, after, firstRow: index === 0 });
      displayLines.push(line);
      displayOffset += line.length + 1;
    }
  }

  return { text: displayLines.join('\n'), spans, glyphs, copyLines, links, rows: displayLines.length };
}

export function copyRelayLine(line: RelayCopyLine, first: number, last: number) {
  const start = line.cells.find(cell => cell.column + cell.width > first);
  const end = line.cells.findLast(cell => cell.column <= last);
  return start && end && start.column <= end.column
    ? line.source.slice(line.firstRow && first <= 0 ? 0 : start.start, end.end)
    : '';
}
