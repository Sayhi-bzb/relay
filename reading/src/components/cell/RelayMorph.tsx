import { useLayoutEffect, useRef } from "react";
import { resolveCharDeskFontRoute, type CharDeskCellMetrics } from "@chardesk/rendering";
import { drawCharDeskCanvasCells, prepareCharDeskCanvasSurface, type CharDeskCanvasCellDrawEntry, type CharDeskFontProfile } from "@chardesk/rendering/canvas";
import { CELL_SURFACE_GUARD_CELLS } from "@/lib/cell-ui/browser";
import { relayMorphPreparedRows, type RelayMorphPlan } from "@/lib/relay-morph-plan";
import { relaySpanStyle } from "@/lib/relay";
import type { CellMarkdownColors } from "@/lib/cell-ui/theme";

export type RelayTransition = Readonly<{ from: string; to: string; firstRow: number; visibleRows: number; sequence: number }>;
export type RelayMorphs = Readonly<Record<string, RelayTransition>>;
const moveDuration = 300;

export default function RelayMorph({ plan, rect, transition, color, colors, background, fontProfile, metrics, onComplete }: Readonly<{
  plan: RelayMorphPlan;
  rect: { x: number; y: number; width: number; height: number };
  transition: RelayTransition;
  color: string;
  colors: CellMarkdownColors;
  background: string;
  fontProfile: CharDeskFontProfile;
  metrics: CharDeskCellMetrics;
  onComplete: () => void;
}>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const finish = useRef(onComplete);
  finish.current = onComplete;
  const end = Math.min(rect.height, transition.visibleRows, relayMorphPreparedRows);
  const start = Math.min(transition.firstRow, Math.max(0, end - 1));
  useLayoutEffect(() => {
    const surface = canvas.current!;
    const context = surface.getContext("2d");
    if (!context || end <= start) { finish.current(); return; }
    const { cellWidth, cellHeight } = metrics;
    const width = rect.width * cellWidth;
    const height = (end - start) * cellHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    prepareCharDeskCanvasSurface(surface, context, width, height, dpr);
    const sprites = new Map<string, { x: number; y: number }>();
    const entries: CharDeskCanvasCellDrawEntry[] = [];
    const positions = (glyph: RelayMorphPlan["to"][number]) => ({ x: glyph.column * cellWidth, y: (glyph.row - start) * cellHeight });
    const pending: { x: number; y: number; width: number; row: number; delay: number }[] = [];
    const moving: { x: number; y: number; px: number; py: number; width: number; row: number; sprite: { x: number; y: number } }[] = [];
    const rowCounts = new Map<number, number>();
    for (const [index, glyph] of plan.to.entries()) {
      if (glyph.row < start || glyph.row >= end) continue;
      const target = positions(glyph);
      const oldIndex = plan.origins[index];
      const old = oldIndex === undefined ? undefined : plan.from[oldIndex];
      if (!old || old.row < start || old.row >= end) {
        const order = rowCounts.get(glyph.row) ?? 0;
        rowCounts.set(glyph.row, order + 1);
        pending.push({ ...target, width: glyph.width * cellWidth, row: glyph.row, delay: order });
        continue;
      }
      const previous = positions(old);
      if (previous.x === target.x && previous.y === target.y) continue;
      const { color: ink, bold, underline } = glyph.style
        ? relaySpanStyle(glyph.style, colors) : { color, bold: false, underline: false };
      const key = JSON.stringify([glyph.segment, glyph.width, ink, bold, underline]);
      let sprite = sprites.get(key);
      if (!sprite) {
        sprite = { x: (entries.length % 16) * cellWidth * 2, y: Math.floor(entries.length / 16) * cellHeight };
        sprites.set(key, sprite);
        entries.push({ ...sprite, drawBackground: false,
          cell: { text: glyph.segment, width: glyph.width, fontRoute: resolveCharDeskFontRoute(glyph.segment),
            attrs: bold ? { bold: true } : undefined },
          options: { metrics, fontProfile, underline, palette: { color: ink, background } } });
      }
      moving.push({ ...target, px: previous.x, py: previous.y, width: glyph.width * cellWidth, row: glyph.row, sprite });
    }
    if (!pending.length && !moving.length) { finish.current(); return; }
    delete surface.dataset.relayFirstGlyph;
    surface.dataset.relayReused = String(moving.length);
    surface.dataset.relayNew = String(pending.length);
    surface.dataset.relayRows = String(new Set([...moving, ...pending].map(glyph => glyph.row)).size);
    for (const glyph of pending) {
      glyph.delay = Math.min(95, (glyph.row - start) * 10) + 12
        + glyph.delay * Math.min(12, 235 / Math.max(1, (rowCounts.get(glyph.row) ?? 1) - 1));
    }
    const atlas = document.createElement("canvas");
    if (entries.length) {
      const atlasContext = atlas.getContext("2d")!;
      prepareCharDeskCanvasSurface(atlas, atlasContext, 32 * cellWidth, Math.ceil(entries.length / 16) * cellHeight, dpr);
      drawCharDeskCanvasCells(atlasContext, entries);
    }
    const duration = Math.max(moving.length ? moveDuration : 0, ...pending.map(glyph => glyph.delay));
    let frameId = 0;
    const paint = (elapsed: number) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = background;
      for (const glyph of pending) if (elapsed < glyph.delay) context.fillRect(glyph.x, glyph.y, glyph.width, cellHeight);
      if (elapsed < moveDuration) {
        const step = 1 - (1 - elapsed / moveDuration) ** 3;
        for (const glyph of moving) context.fillRect(glyph.x, glyph.y, glyph.width, cellHeight);
        for (const { x, y, px, py, width: glyphWidth, sprite } of moving) {
          context.drawImage(atlas, sprite.x * dpr, sprite.y * dpr, glyphWidth * dpr, cellHeight * dpr,
            px + (x - px) * step, py + (y - py) * step, glyphWidth, cellHeight);
        }
      }
      if (!surface.dataset.relayFirstGlyph && pending.length && elapsed >= pending[0]!.delay) surface.dataset.relayFirstGlyph = "visible";
    };
    paint(0);
    const started = performance.now();
    const animate = (time: number) => {
      const elapsed = Math.max(0, time - started);
      paint(elapsed);
      if (elapsed >= duration) finish.current();
      else frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [plan, rect.width, start, end, color, colors, background, fontProfile, metrics]);
  return <canvas ref={canvas} className="relay-morph-clip" aria-hidden="true" data-relay-morph={transition.sequence} data-relay-cell-morph=""
    style={{ left: (rect.x + CELL_SURFACE_GUARD_CELLS) * metrics.cellWidth, top: (rect.y + start + CELL_SURFACE_GUARD_CELLS) * metrics.cellHeight }} />;
}
