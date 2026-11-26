import { diffSegments, segmentText, type Segment } from "torph";
import type { layoutRelay, RelayGlyph } from "./relay-layout.ts";

type Inline = ReturnType<typeof layoutRelay>;
type Glyph = RelayGlyph;
export type RelayMorphPlan = Readonly<{ from: Glyph[]; to: Glyph[]; origins: (number | undefined)[] }>;
const plans = new WeakMap<Inline, WeakMap<Inline, RelayMorphPlan>>();
export const relayMorphPreparedRows = 44;

function textGlyphs(inline: Inline) {
  const glyphs: Glyph[] = [];
  for (const glyph of inline.glyphs) {
    if (glyph.row >= relayMorphPreparedRows) break;
    if (!glyph.decoration && glyph.segment.trim()) glyphs.push(glyph);
  }
  return glyphs;
}

function values(segments: Segment[], glyphs: Glyph[]): Segment[] {
  const chars = segments.filter(segment => segment.string.trim());
  return chars.length === glyphs.length && chars.every(({ string }, index) => glyphs[index]!.segment === string) ? chars : [];
}

function cachePlan(from: Inline, to: Inline, plan: RelayMorphPlan) {
  const destinations = plans.get(from) ?? new WeakMap<Inline, RelayMorphPlan>();
  destinations.set(to, plan);
  plans.set(from, destinations);
}

export function prepareCellMorph(from: Inline, to: Inline) {
  const cached = plans.get(from)?.get(to);
  if (cached) return cached;
  const oldGlyphs = textGlyphs(from);
  const newGlyphs = textGlyphs(to);
  const encoded = (glyphs: Glyph[]) => glyphs.map(glyph => glyph.segment).join(" ");
  const base = segmentText(encoded(oldGlyphs), "en", false);
  const next = diffSegments(base, encoded(newGlyphs), "en", { numbers: false }).segments;
  const oldIds = new Map(values(base, oldGlyphs).map(({ id }, index) => [id, index]));
  const directions = values(next, newGlyphs).map(({ id }) => oldIds.get(id));
  const inverse: (number | undefined)[] = [];
  directions.forEach((index, destination) => { if (index !== undefined) inverse[index] = destination; });
  const plan = { from: oldGlyphs, to: newGlyphs, origins: directions };
  cachePlan(from, to, plan);
  cachePlan(to, from, { from: newGlyphs, to: oldGlyphs, origins: inverse });
  return plan;
}
