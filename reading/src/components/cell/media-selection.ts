import { createCharDeskRenderModel } from "@chardesk/rendering";
import { CellBuffer } from "@/lib/cell-ui/buffer";
import { extractCellRange } from "@/lib/cell-ui/range";
import type { CellRect } from "@/lib/cell-ui/types";
import { copyRelayLine, type RelayCopyLine } from "@/lib/relay-layout";

export type SelectionPoint = Readonly<{ x: number; y: number }>;
export const FITTED_MEDIA_INK_GUARD_CELLS = 1;
export const FITTED_MEDIA_CONTROL_CELLS = 1;
export const FITTED_MEDIA_RESERVED_CELLS = FITTED_MEDIA_INK_GUARD_CELLS + FITTED_MEDIA_CONTROL_CELLS;

export function fittedMediaPaintGeometry(media: Readonly<{
  width: number;
  scale: number;
  rect: Readonly<{ x: number; y: number; width: number }>;
}>, cellWidth: number, cellHeight: number, surfaceGuard: number) {
  const contentWidthCells = Math.max(1, media.rect.width - FITTED_MEDIA_RESERVED_CELLS);
  const scale = Math.min(media.scale, contentWidthCells / media.width);
  const canvasLeft = (surfaceGuard + media.rect.x - FITTED_MEDIA_INK_GUARD_CELLS) * cellWidth;
  const canvasTop = (surfaceGuard + media.rect.y - FITTED_MEDIA_INK_GUARD_CELLS) * cellHeight;
  const paintLeft = (surfaceGuard + media.rect.x) * cellWidth
    + Math.max(0, (contentWidthCells - media.width * scale) * cellWidth / 2);
  const paintTop = (surfaceGuard + media.rect.y) * cellHeight;
  return { scale, contentWidthCells, canvasLeft, canvasTop, paintLeft, paintTop };
}
export type SelectionMedia = Readonly<{
  key: string;
  source: string;
  width: number;
  rows: number;
  scale: number;
  rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  buffer?: CellBuffer;
}>;
export type DocumentSelection = Readonly<{
  shape: "linear" | "rectangle";
  anchor: SelectionPoint;
  head: SelectionPoint;
  text: string;
  hostSpans: readonly CellRect[];
  mediaSpans: Readonly<Record<string, readonly Readonly<{ x: number; y: number; width: number; height: 1 }> []>>;
}>;

type Row = Readonly<{
  mediaKey?: string;
  buffer: CellBuffer;
  y: number;
  top: number;
  bottom: number;
  left: number;
  cellWidth: number;
}>;
type RowSpan = Readonly<{ x: number; y: number; width: number; height: 1 }>;

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function selectedInkSpan(row: Row, first: number, last: number): RowSpan | null {
  let inkStart = row.buffer.width;
  let inkEnd = 0;
  for (let x = first; x <= last; x++) {
    const cell = row.buffer.get(x, row.y);
    if (!cell || cell.continuation || !/\S/u.test(cell.text)) continue;
    inkStart = Math.min(inkStart, x);
    inkEnd = Math.max(inkEnd, x + cell.width);
  }
  return inkEnd > inkStart ? { x: inkStart, y: row.y, width: inkEnd - inkStart, height: 1 } : null;
}

export function mediaCellBuffer(source: string, width: number, rows: number): CellBuffer {
  const buffer = new CellBuffer({ width, height: rows });
  for (const cell of createCharDeskRenderModel(source, { syntax: "auto" }).cells) {
    if (cell.x < width && cell.y < rows) buffer.writeGrapheme(cell.x, cell.y, cell.text, "media");
  }
  return buffer;
}

/** Coordinates are CSS pixels local to the CellSurface, including its guard. */
export function selectDocumentText(input: Readonly<{
  shape: "linear" | "rectangle";
  anchor: SelectionPoint;
  head: SelectionPoint;
  buffer: CellBuffer;
  media: readonly SelectionMedia[];
  cellWidth: number;
  cellHeight: number;
  guard: number;
  relayRows?: ReadonlyMap<number, Readonly<{ left: number; line: RelayCopyLine }>>;
}>): DocumentSelection {
  const { buffer, media, cellWidth, cellHeight, guard } = input;
  const rows: Row[] = [];
  const occupied = new Set<number>();
  for (const item of media) {
    for (let y = item.rect.y; y < item.rect.y + item.rect.height; y++) occupied.add(y);
    const local = item.buffer ?? mediaCellBuffer(item.source, item.width, item.rows);
    const { scale, paintLeft: left, paintTop } = fittedMediaPaintGeometry(item, cellWidth, cellHeight, guard);
    for (let y = 0; y < item.rows; y++) {
      const top = paintTop + y * cellHeight * scale;
      rows.push({ mediaKey: item.key, buffer: local, y, top, bottom: top + cellHeight * scale,
        left, cellWidth: cellWidth * scale });
    }
  }
  for (let y = 0; y < buffer.height; y++) {
    if (occupied.has(y)) continue;
    const top = (guard + y) * cellHeight;
    rows.push({ buffer, y, top, bottom: top + cellHeight, left: guard * cellWidth, cellWidth });
  }
  rows.sort((a, b) => a.top - b.top || Number(Boolean(a.mediaKey)) - Number(Boolean(b.mediaKey)));
  const cellAt = (row: Row, x: number) => clamp(Math.floor((x - row.left) / row.cellWidth), 0, row.buffer.width - 1);
  const positionAt = (point: SelectionPoint) => {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (point.y < row.top) {
        // Layout space has no cells: stay at the previous content boundary.
        if (index === 0) return { row: 0, x: 0 };
        const previous = rows[index - 1]!;
        return { row: index - 1, x: previous.buffer.width - 1 };
      }
      if (point.y < row.bottom) return { row: index, x: cellAt(row, point.x) };
    }
    const last = rows.length - 1;
    return { row: last, x: rows[last]!.buffer.width - 1 };
  };
  const anchor = positionAt(input.anchor);
  const head = positionAt(input.head);
  const anchorRow = anchor.row;
  const headRow = head.row;
  const anchorX = anchor.x;
  const headX = head.x;
  const forward = anchorRow < headRow || (anchorRow === headRow && anchorX <= headX);
  const startRow = forward ? anchorRow : headRow;
  const endRow = forward ? headRow : anchorRow;
  const startX = forward ? anchorX : headX;
  const endX = forward ? headX : anchorX;
  const leftPx = Math.min(input.anchor.x, input.head.x);
  const rightPx = Math.max(input.anchor.x, input.head.x);
  const topPx = Math.min(input.anchor.y, input.head.y);
  const bottomPx = Math.max(input.anchor.y, input.head.y);
  const lines: { text: string; after: string }[] = [];
  const seenCopyGroups = new Set<string>();
  const hostSpans: CellRect[] = [];
  const mediaSpans: Record<string, RowSpan[]> = {};
  rows.forEach((row, index) => {
    if (input.shape === "linear" && (index < startRow || index > endRow)) return;
    if (input.shape === "rectangle" && (row.bottom <= topPx || row.top > bottomPx)) return;
    let first: number;
    let last: number;
    if (input.shape === "linear") {
      first = index === startRow ? startX : 0;
      last = index === endRow ? endX : row.buffer.width - 1;
    } else {
      first = clamp(Math.floor((leftPx - row.left) / row.cellWidth), 0, row.buffer.width - 1);
      last = clamp(Math.ceil((rightPx - row.left) / row.cellWidth) - 1, 0, row.buffer.width - 1);
      if (rightPx < row.left || leftPx >= row.left + row.buffer.width * row.cellWidth) return;
    }
    if (last < first) return;
    const firstCell = row.buffer.get(first, row.y);
    const lastCell = row.buffer.get(last, row.y);
    if (firstCell?.continuation) first--;
    if (lastCell?.continuation) last = Math.min(row.buffer.width - 1, last + 1);
    else if (lastCell?.width === 2) last = Math.min(row.buffer.width - 1, last + 1);
    const span = { x: first, y: row.y, width: last - first + 1, height: 1 as const };
    const relay = input.shape === "linear" && !row.mediaKey ? input.relayRows?.get(row.y) : undefined;
    lines.push(relay
      ? { text: copyRelayLine(relay.line, first - relay.left, last - relay.left), after: relay.line.after }
      : { text: extractCellRange(row.buffer, span, { trimEnd: true, sourceAware: true, seenCopyGroups }), after: "\n" });
    const paintSpan = selectedInkSpan(row, first, last);
    if (!paintSpan) return;
    if (row.mediaKey) (mediaSpans[row.mediaKey] ??= []).push(paintSpan);
    else hostSpans.push(paintSpan);
  });
  return { shape: input.shape, anchor: input.anchor, head: input.head,
    text: lines.map(({ text, after }, index) => index < lines.length - 1 ? text + after : text).join(""),
    hostSpans, mediaSpans };
}
