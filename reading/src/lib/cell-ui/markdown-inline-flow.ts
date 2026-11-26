import { getGraphemeCellWidth, iterateGraphemes } from "@chardesk/protocol";
import { layoutInlineLines } from "./inline-line-breaks.ts";
import type { CellTextStyle } from "./types.js";
import type { FormulaGeometry } from "./formula.js";

export type MarkdownInlineTone = "strong" | "accent" | "link" | "quote" | "muted"
  | "codeKey" | "codeValue" | "codeCommand" | "codeComment";
export type MarkdownInlineRun = Readonly<{
  text: string;
  style: CellTextStyle;
  tone?: MarkdownInlineTone;
  code?: boolean;
  linkIndex?: number;
  math?: Readonly<{ source: string; geometry: FormulaGeometry }>;
}>;
export type MarkdownInlineGlyph = Readonly<{
  text: string;
  x: number;
  y: number;
  width: number;
  runIndex: number;
  linkIndex?: number;
  math?: Readonly<{ source: string; geometry: FormulaGeometry }>;
}>;
export type MarkdownInlineLayout = Readonly<{
  width: number;
  height: number;
  glyphs: readonly MarkdownInlineGlyph[];
}>;

type Glyph = Readonly<{ text: string; width: number; runIndex: number; linkIndex?: number;
  math?: Readonly<{ source: string; geometry: FormulaGeometry }> }>;
const layoutCache = new WeakMap<readonly MarkdownInlineRun[], Map<number, MarkdownInlineLayout>>();

const glyphsFor = (runs: readonly MarkdownInlineRun[]) =>
  runs.flatMap((run, runIndex): (Glyph & { atomic?: boolean })[] => run.math
    ? [{ text: "", width: run.math.geometry.columns, runIndex, math: run.math, atomic: true }]
    : [...iterateGraphemes(run.text)].map(({ segment }): Glyph => ({
      text: segment, width: getGraphemeCellWidth(segment), runIndex,
      ...(run.linkIndex === undefined ? {} : { linkIndex: run.linkIndex }),
    })));

/** One line map is shared by measuring, painting, and Markdown link hit regions. */
export const layoutMarkdownInlineFlow = (runs: readonly MarkdownInlineRun[], widthLimit: number): MarkdownInlineLayout => {
  const limit = Math.max(1, Math.floor(widthLimit));
  let widths = layoutCache.get(runs);
  const cached = widths?.get(limit);
  if (cached) return cached;
  const glyphs: MarkdownInlineGlyph[] = [];
  let y = 0;
  let widest = 0;
  const ink = glyphsFor(runs);
  for (const { start, end } of layoutInlineLines(ink, limit)) {
    let x = 0;
    let ascent = 1;
    let descent = 0;
    for (let index = start; index < end; index++) {
      const geometry = ink[index]!.math?.geometry;
      ascent = Math.max(ascent, geometry?.ascentRows ?? 1);
      descent = Math.max(descent, geometry?.descentRows ?? 0);
    }
    for (let index = start; index < end; index++) {
      const glyph = ink[index]!;
      glyphs.push({ ...glyph, x, y: y + ascent - (glyph.math?.geometry.ascentRows ?? 1) });
      x += glyph.width;
    }
    widest = Math.max(widest, x);
    y += ascent + descent;
  }
  const result = { width: widest, height: y, glyphs };
  if (!widths) {
    widths = new Map();
    layoutCache.set(runs, widths);
  }
  if (widths.size >= 16) widths.delete(widths.keys().next().value!);
  widths.set(limit, result);
  return result;
};
