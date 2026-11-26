import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createCharDeskFontProfile } from "@chardesk/fonts";
import { MAPLE_FONT_FAMILY, MAPLE_FONT_SOURCES } from "@chardesk/font-maple";
import "@chardesk/font-maple/fonts.css";
import "katex/dist/katex.min.css";
import { decodeCharDeskTextRuns, getTextCellWidth, iterateGraphemes } from "@chardesk/protocol";
import { createCharDeskRectRangeGeometry, createCharDeskRenderModel } from "@chardesk/rendering";
import { drawCharDeskCanvasDocument, drawCharDeskCanvasRange, prepareCharDeskCanvasSurface } from "@chardesk/rendering/canvas";
import {
  Box, Button, CLASSIC_MAC_DARK_THEME, CLASSIC_MAC_LIGHT_THEME, Formula, Link, Markdown, Root, ScrollArea, Text,
  YogaLayoutEngine, createWidgetDescriptor, reconcileWidgetTree, resolveCellUiScrollLayout,
  type CellRangeSnapshot, type LayoutEntry, type RootProps, type WidgetCommand,
} from "@/lib/cell-ui";
import { CELL_SURFACE_GUARD_CELLS, CellSurface, DEFAULT_CELL_UI_METRICS, useCellScrollState, type CellScrollState } from "@/lib/cell-ui/browser";
import { MarkdownBlock } from "@/lib/cell-ui/react";
import type { BlogPageModel, CellDocumentNode, ImageSizes, PostCard, RelayDocument, RelayViews } from "./model";
import { ArticleImage, ArticleImageCarousel, ArticleImageViewer, articleImageRows, articleImages, type ArticleImageLayout, type ArticleImageNode, type ArticleImagePreview } from "./ArticleImage";
import { cellDemoApi } from "@/lib/cell-demo.js";
import { demoHtmlToProtocol } from "@/lib/cell-demo-browser.js";
import { FITTED_MEDIA_INK_GUARD_CELLS, FITTED_MEDIA_RESERVED_CELLS, fittedMediaPaintGeometry,
  mediaCellBuffer, selectDocumentText, type DocumentSelection, type SelectionMedia } from "./media-selection";
import { formulaCopyText, formulaKey, type FormulaGeometry, type FormulaGeometryMap } from "@/lib/cell-ui/formula";
import { layoutMarkdownInlineFlow } from "@/lib/cell-ui/markdown-inline-flow";
import { walkCellTextRows } from "@/lib/cell-ui/text-lines";
import { measureDocumentFormulas } from "./formula-metrics";
import { articleImageStripRows } from "@/lib/article-image-strip";

import { changeRelayView, prepareRelayText, relayHeadingTarget, relaySpanStyle, relayText, relayView } from '@/lib/relay';
import type { RelayCopyLine } from '@/lib/relay-layout';
import { prepareCellMorph } from '@/lib/relay-morph-plan';
import { relayThemes } from '@/lib/relay-theme';
import RelayMorph, { type RelayMorphs } from './RelayMorph';
import ReadingRuler from './ReadingRuler';

type RelayReading = Readonly<{ views: RelayViews; colors: typeof CLASSIC_MAC_LIGHT_THEME.markdownColors; canHover: boolean; hovered: string | null; focused: string | null; images: ArticleImageLayout }>;

const fontFamily = "Fusion Pixel 12px Mono latin";
const fontStack = `'${fontFamily}', ${MAPLE_FONT_FAMILY}`;
const fontProfile = createCharDeskFontProfile({
  id: "blog/fusion-pixel-maple-2026.09.01",
  display: { families: { regular: fontStack } },
  cjk: { families: { regular: fontStack } },
  sources: [{ id: "fusion-mono", family: fontFamily, version: "2026.09.01" }, ...MAPLE_FONT_SOURCES],
});
const TOC_BREAKPOINT = 1240;
const surfaceGuardHeight = CELL_SURFACE_GUARD_CELLS * DEFAULT_CELL_UI_METRICS.cellHeight;
const EMPTY_HOST_RANGE_SPANS = [] as const;
const ICON_LINKS = [
  { id: "blog-rss", source: "/assets/icons/RSS.svg" },
  { id: "blog-email", source: "/assets/icons/Envelope.svg" },
] as const;
type HeadingNode = Extract<CellDocumentNode, { kind: "heading" }>;

function documentHeadings(nodes: readonly CellDocumentNode[]): HeadingNode[] {
  return nodes.flatMap((node): HeadingNode[] => {
    if (node.kind === "heading") return [node];
    if (node.kind === "center" || node.kind === "quote") return documentHeadings(node.children);
    if (node.kind === "list") return node.items.flatMap(documentHeadings);
    return [];
  });
}

function fitTocLabel(label: string, width: number): string {
  if (getTextCellWidth(label) <= width) return label;
  let result = "";
  for (const { segment } of iterateGraphemes(label)) {
    if (getTextCellWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + "…";
}

function tocContent(headings: readonly HeadingNode[], lang: BlogPageModel["lang"], activeId: string | null, width: number,
  selectedStyle: typeof CLASSIC_MAC_LIGHT_THEME.selectedStyle) {
  const shallowest = Math.min(...headings.map((heading) => heading.level));
  return <Box id="blog-toc-content" style={{ width: "100%", gap: 1 }}>
    <Text textStyle={{ bold: true }}>{lang === "zh-CN" ? "本页目录" : "On This Page"}</Text>
    <Box style={{ width: "100%", gap: 0 }}>
      {headings.map((heading) => {
        const indent = Math.min(4, heading.level - shallowest);
        return <Link key={heading.id} id={`toc-${heading.id}`} href={`#${heading.id}`}
          label={heading.label} current={activeId === heading.id ? "location" : undefined}
          textStyle={activeId === heading.id ? selectedStyle : undefined}>
          {" ".repeat(indent) + fitTocLabel(heading.label, Math.max(2, width - indent))}
        </Link>;
      })}
    </Box>
  </Box>;
}

type TextRun = Readonly<{ text: string; color?: string; bgColor?: string; attrs?: Readonly<Record<string, boolean>> }>;

function asciiLines(source: string): TextRun[][] {
  const decoded = decodeCharDeskTextRuns(source, { syntax: "auto" });
  if (decoded.diagnostics.length) throw new Error(`Invalid CharDesk text: ${decoded.diagnostics.map((item) => item.message).join("; ")}`);
  const lines: TextRun[][] = [[]];
  for (const run of decoded.runs) {
    const chunks = run.text.split("\n");
    chunks.forEach((chunk, index) => {
      if (index) lines.push([]);
      if (chunk) lines[lines.length - 1]!.push({ ...run, text: chunk });
    });
  }
  return lines;
}

function asciiSize(source: string, stableWidth = 0, stableRows = 0) {
  const lines = asciiLines(source);
  return {
    width: Math.max(stableWidth, 0, ...lines.map((line) => line.reduce((total, run) => total + getTextCellWidth(run.text), 0))),
    rows: Math.max(stableRows, lines.length),
  };
}

function asciiContent(source: string, key: string, width: number, stableWidth = 0, stableRows = 0) {
  const lines = asciiLines(source);
  const contentWidth = Math.max(stableWidth, 0, ...lines.map((line) => line.reduce((total, run) => total + getTextCellWidth(run.text), 0)));
  while (lines.length < stableRows) lines.push([]);
  const offset = Math.max(0, Math.floor((width - contentWidth) / 2));
  const content = <Box id={key} key={key} style={{ width: Math.max(width, contentWidth), gap: 0 }}>
    {lines.map((line, row) => <Box key={`${key}-${row}`} style={{ direction: "row", width: Math.max(width, contentWidth), minHeight: 1 }}>
      {offset ? <Text>{" ".repeat(offset)}</Text> : null}
      {line.length ? line.map((run, index) => <Text key={`${key}-${row}-${index}`} textStyle={{
        color: run.attrs?.inverse ? run.bgColor : run.color,
        backgroundColor: run.attrs?.inverse ? run.color : run.bgColor,
        bold: run.attrs?.bold, italic: run.attrs?.italic, underline: run.attrs?.underline,
        strike: run.attrs?.strike, dim: run.attrs?.dim,
      }}>{run.text}</Text>) : <Text> </Text>}
    </Box>)}
  </Box>;
  return { content, contentWidth, rows: lines.length };
}

function asciiNode(source: string, key: string, width: number, scroll: CellScrollState, stableWidth = 0, stableRows = 0) {
  const { content, contentWidth, rows } = asciiContent(source, key, width, stableWidth, stableRows);
  if (contentWidth <= width) return content;
  const scrollId = `${key}-scroll`;
  return <ScrollArea id={scrollId} key={key} variant="ghost" scrollX={scroll.offset(scrollId).x}
    scrollY={scroll.offset(scrollId).y} style={{ width: "100%", height: rows }}>{content}</ScrollArea>;
}

type MediaNode = Extract<CellDocumentNode, { kind: "ascii" | "animation" | "demo" }>;
type FittedMedia = Readonly<{ key: string; node: MediaNode; width: number; rows: number; available: number; scale: number; slotRows: number }>;

function mediaSource(node: MediaNode, key: string, frames: Readonly<Record<string, string>>) {
  return node.kind === "ascii" ? node.source : frames[key] ?? (node.kind === "animation" ? node.frames[0] ?? "" : node.initial);
}

function mediaSize(node: MediaNode) {
  return node.kind === "ascii" ? asciiSize(node.source)
    : asciiSize(node.kind === "animation" ? node.frames[0] ?? "" : node.initial, node.width, node.rows);
}

function fittedMedia(node: MediaNode, key: string, available: number): FittedMedia | null {
  const size = mediaSize(node);
  if (size.width <= available || available <= FITTED_MEDIA_RESERVED_CELLS) return null;
  const scale = Math.max(1, available - FITTED_MEDIA_RESERVED_CELLS) / size.width;
  return { key, node, width: size.width, rows: size.rows, available, scale, slotRows: Math.max(1, Math.ceil(size.rows * scale)) };
}

function collectFittedMedia(nodes: readonly CellDocumentNode[], width: number, path = "doc"): FittedMedia[] {
  return nodes.flatMap((node, index) => {
    const key = `${path}-${index}`;
    if (node.kind === "ascii" || node.kind === "animation" || node.kind === "demo") {
      const media = fittedMedia(node, key, width);
      return media ? [media] : [];
    }
    if (node.kind === "center") return node.children.flatMap((child, childIndex) => collectFittedMedia([child], width, `${key}-${childIndex}`));
    if (node.kind === "quote") return collectFittedMedia(node.children, Math.max(1, width - 2), key);
    if (node.kind === "list") return node.items.flatMap((item, itemIndex) => collectFittedMedia(item, Math.max(1, width - 3), `${key}-${itemIndex}`));
    return [];
  });
}

function absoluteLayoutRect(entries: ReadonlyMap<string, LayoutEntry>, id: string) {
  const entry = entries.get(id);
  if (!entry) return null;
  let x = entry.rect.x;
  let y = entry.rect.y;
  let parentId = entry.parentId;
  while (parentId) {
    const parent = entries.get(parentId);
    if (!parent) break;
    x += parent.rect.x;
    y += parent.rect.y;
    parentId = parent.parentId;
  }
  return { ...entry.rect, x, y };
}

type FormulaPlacement = Readonly<{ key: string; source: string; geometry: FormulaGeometry;
  rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  clip?: Readonly<{ x: number; y: number; width: number; height: number }> }>;

function FormulaInk({ placement, color }: Readonly<{ placement: FormulaPlacement; color: string }>) {
  const { rect, clip, geometry } = placement;
  const cellWidth = DEFAULT_CELL_UI_METRICS.cellWidth;
  const cellHeight = DEFAULT_CELL_UI_METRICS.cellHeight;
  const guard = CELL_SURFACE_GUARD_CELLS;
  const inkTop = rect.y * cellHeight + geometry.topOffsetPx;
  const clipStyle = clip ? { clipPath: `inset(${Math.max(0, clip.y * cellHeight - inkTop)}px ${Math.max(0, rect.x + rect.width - clip.x - clip.width) * cellWidth}px ${Math.max(0, inkTop + geometry.pixelHeight - (clip.y + clip.height) * cellHeight)}px ${Math.max(0, clip.x - rect.x) * cellWidth}px)` } : {};
  return <span className="cell-blog-math-ink" data-cell-math={placement.key} aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: geometry.html }}
    style={{ position: "absolute", left: (guard + rect.x) * cellWidth,
      top: guard * cellHeight + inkTop,
      width: geometry.pixelWidth, height: geometry.pixelHeight, fontSize: geometry.fontSizePx,
      color, pointerEvents: "none", ...clipStyle }} />;
}

function IconInk({ id, source, rect, color }: Readonly<{ id: string; source: string;
  rect: Readonly<{ x: number; y: number; width: number; height: number }>; color: string }>) {
  const cellWidth = DEFAULT_CELL_UI_METRICS.cellWidth;
  const cellHeight = DEFAULT_CELL_UI_METRICS.cellHeight;
  const guard = CELL_SURFACE_GUARD_CELLS;
  return <span className="cell-blog-icon-ink" data-cell-icon={id}
    style={{ left: (guard + rect.x) * cellWidth, top: (guard + rect.y) * cellHeight,
      width: rect.width * cellWidth, height: rect.height * cellHeight,
      backgroundColor: color, maskImage: `url(${source})`, WebkitMaskImage: `url(${source})` }} />;
}

function FittedMediaCanvas({ media, source, rect, background, foreground, selection, rangeStyle }: Readonly<{
  media: FittedMedia;
  source: string;
  rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  background: string;
  foreground: string;
  selection: DocumentSelection | null;
  rangeStyle: typeof CLASSIC_MAC_LIGHT_THEME.rangeStyle;
}>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellWidth = DEFAULT_CELL_UI_METRICS.cellWidth;
  const cellHeight = DEFAULT_CELL_UI_METRICS.cellHeight;
  const geometry = fittedMediaPaintGeometry({ width: media.width, scale: media.scale, rect },
    cellWidth, cellHeight, CELL_SURFACE_GUARD_CELLS);
  const { scale, contentWidthCells, canvasLeft, canvasTop, paintLeft, paintTop } = geometry;
  const canvasWidth = (contentWidthCells + 2 * FITTED_MEDIA_INK_GUARD_CELLS) * cellWidth;
  const canvasHeight = (media.slotRows + 2 * FITTED_MEDIA_INK_GUARD_CELLS) * cellHeight;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let live = true;
    const model = createCharDeskRenderModel(source, { syntax: "auto" });
    const paint = () => {
      if (!live) return;
      prepareCharDeskCanvasSurface(canvas, context, canvasWidth, canvasHeight, Math.max(1, window.devicePixelRatio || 1));
      context.fillStyle = background;
      context.fillRect(FITTED_MEDIA_INK_GUARD_CELLS * cellWidth,
        FITTED_MEDIA_INK_GUARD_CELLS * cellHeight, contentWidthCells * cellWidth, media.slotRows * cellHeight);
      context.save();
      context.translate(paintLeft - canvasLeft, paintTop - canvasTop);
      drawCharDeskCanvasDocument(context, model, {
        metrics: DEFAULT_CELL_UI_METRICS, palette: { color: foreground, background }, fontProfile, zoom: scale, padding: 0,
      });
      const spans = selection?.mediaSpans[media.key] ?? [];
      if (spans.length) drawCharDeskCanvasRange(context, {
        geometry: { polygons: spans.flatMap((span) => createCharDeskRectRangeGeometry(span).polygons) },
        phase: "resting", style: rangeStyle, options: { metrics: DEFAULT_CELL_UI_METRICS, zoom: scale },
      });
      context.restore();
    };
    paint();
    if (document.fonts.status !== "loaded") void document.fonts.ready.then(paint);
    return () => { live = false; };
  }, [background, canvasHeight, canvasLeft, canvasTop, canvasWidth, cellHeight, cellWidth, contentWidthCells,
    foreground, media.key, media.slotRows, paintLeft, paintTop, rangeStyle, scale, selection, source]);
  return <canvas ref={canvasRef} aria-hidden="true" data-cell-embed={media.key} data-fit-scale={scale.toFixed(4)}
    style={{ position: "absolute", left: canvasLeft, top: canvasTop, pointerEvents: "none" }} />;
}

function MediaViewer({ media, source, lang, theme, onClose }: Readonly<{
  media: FittedMedia;
  source: string;
  lang: BlogPageModel["lang"];
  theme: typeof CLASSIC_MAC_LIGHT_THEME;
  onClose: () => void;
}>) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const scroll = useCellScrollState();
  const [windowSize, setWindowSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    viewerRef.current?.querySelector<HTMLElement>("[data-cell-surface]")?.focus();
    return () => { window.removeEventListener("resize", update); document.body.style.overflow = previousOverflow; };
  }, []);
  const width = Math.max(1, Math.min(media.width, Math.floor(windowSize.width * 0.9 / DEFAULT_CELL_UI_METRICS.cellWidth) - 2 * CELL_SURFACE_GUARD_CELLS));
  const visibleRows = Math.max(1, Math.min(media.rows, Math.floor(windowSize.height * 0.85 / DEFAULT_CELL_UI_METRICS.cellHeight) - 4));
  const content = asciiContent(source, "media-viewer-content", media.width, media.width, media.rows).content;
  const root = <Root id="media-viewer-root" style={{ width: "100%" }}><Box style={{ width: "100%", gap: 1 }}>
    <Box style={{ direction: "row", width: "100%" }}>
      <Text>{lang === "zh-CN" ? "原尺寸" : "Original size"}</Text>
      <Box style={{ flexGrow: 1 }} />
      <Button id="media-viewer-close" label={lang === "zh-CN" ? "关闭" : "Close"} variant="ghost"><Text>×</Text></Button>
    </Box>
    <ScrollArea id="media-viewer-scroll" variant="ghost" scrollX={scroll.offset("media-viewer-scroll").x}
      scrollY={scroll.offset("media-viewer-scroll").y} style={{ width: "100%", height: visibleRows }}>{content}</ScrollArea>
  </Box></Root>;
  return <div className="cell-blog-media-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="cell-blog-media-viewer" role="dialog" aria-modal="true" aria-label={lang === "zh-CN" ? "演示原尺寸" : "Demo at original size"}
      ref={viewerRef} onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <CellSurface label={lang === "zh-CN" ? "演示原尺寸" : "Demo at original size"} viewport={{ width, height: visibleRows + 2 }}
        theme={theme} palette={{ color: theme.foreground, background: theme.background }} fontProfile={fontProfile}
        metrics={DEFAULT_CELL_UI_METRICS} linearSelection onCommand={(command) => {
          scroll.dispatch(command);
          if (command.type === "activate" && command.targetId === "media-viewer-close") onClose();
        }}>{root}</CellSurface>
    </div>
  </div>;
}

function mediaNode(node: MediaNode, key: string, width: number, frames: Readonly<Record<string, string>>, scroll: CellScrollState, lang: BlogPageModel["lang"]) {
  const fit = fittedMedia(node, key, width);
  const source = mediaSource(node, key, frames);
  if (!fit) return asciiNode(source, key, width, scroll, node.kind === "ascii" ? 0 : node.width, node.kind === "ascii" ? 0 : node.rows);
  return <Box id={key} key={key} style={{ width: "100%", gap: 0 }}>
    <Box style={{ width: "100%", height: fit.slotRows, flexShrink: 0 }} />
    <Button id={`media-expand:${key}`} label={lang === "zh-CN" ? "查看原尺寸" : "View at original size"}
      variant="ghost" style={{ position: "absolute", top: 0, right: 0, width: 1, height: 1,
        paddingLeft: 0, paddingRight: 0 }}><Text>↗</Text></Button>
  </Box>;
}

function centeredTextRows(source: string, width: number, key: string): ReactElement {
  const rows: string[] = [];
  const measured = walkCellTextRows(source, Math.max(1, width), ({ segment, row }) => {
    rows[row] = (rows[row] ?? "") + segment;
  });
  return <Box key={key} style={{ width: "100%", gap: 0 }}>
    {Array.from({ length: measured.height }, (_, row) => {
      const text = rows[row] ?? "";
      const inset = Math.max(0, Math.floor((width - getTextCellWidth(text)) / 2));
      return <Box key={row} style={{ direction: "row", width: "100%", height: 1, gap: 0 }}>
        {inset ? <Box style={{ width: inset }} /> : null}<Text>{text || " "}</Text>
      </Box>;
    })}
  </Box>;
}

function documentNodes(nodes: readonly CellDocumentNode[], width: number, frames: Readonly<Record<string, string>>,
  scroll: CellScrollState, lang: BlogPageModel["lang"], formulas: FormulaGeometryMap, path: string, images: ArticleImageLayout): ReactElement[] {
  return nodes.map((node, index) => {
    const key = `${path}-${index}`;
    switch (node.kind) {
      case "markdown": {
        const content = <Markdown id={key} key={key} source={node.source} formulaGeometry={formulas} />;
        if (!node.wideContent) return content;
        const scrollId = `${key}-scroll`;
        return <ScrollArea id={scrollId} key={key} variant="ghost" scrollX={scroll.offset(scrollId).x}
          scrollY={0} style={{ width: "100%" }}>{content}</ScrollArea>;
      }
      case "heading": return <Markdown id={path.startsWith("relay-original") ? `${key}-${node.id}` : node.id} key={key} source={node.source} formulaGeometry={formulas} />;
      case "ascii":
      case "animation":
      case "demo": return mediaNode(node, key, width, frames, scroll, lang);
      case "image": {
        if (nodes[index - 1]?.kind === "image") return null;
        const id = `article-image:${key}`;
        const gallery: ArticleImageNode[] = [];
        for (let next = index; next < nodes.length; next++) {
          const image = nodes[next];
          if (image?.kind !== "image") break;
          const size = image.size ?? images.sizes[image.src];
          gallery.push(size ? { ...image, size } : image);
        }
        images.slots?.set(id, gallery);
        const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
        const height = gallery.length === 1 ? articleImageRows(width, gallery[0]?.size)
          : articleImageStripRows(width * cellWidth, cellHeight, cellWidth, gallery.map(image => image.size));
        return <Box key={key} id={id} style={{ width: "100%", height, flexShrink: 0 }} />;
      }
      case "math": {
        const geometry = formulas[formulaKey(node.source, true)];
        if (!geometry) return <Text id={key} key={key}>{formulaCopyText(node.source, true)}</Text>;
        const formula = <Formula id={key} source={node.source} geometry={geometry}
          style={{ width: geometry.columns, height: geometry.rows, flexShrink: 0 }} />;
        if (geometry.columns > width) return <ScrollArea id={`${key}-scroll`} key={key} variant="ghost"
          scrollX={scroll.offset(`${key}-scroll`).x} scrollY={0}
          style={{ width: "100%", height: geometry.rows }}>{formula}</ScrollArea>;
        return <Box key={key} style={{ direction: "row", width: "100%", height: geometry.rows, gap: 0 }}>
          <Box style={{ width: Math.floor((width - geometry.columns) / 2) }} />{formula}
        </Box>;
      }
      case "center": return <Box id={key} key={key} style={{ width: "100%", gap: 0 }}>
        {node.children.map((child, childIndex) => child.kind === "markdown"
          ? centeredTextRows(child.source, width, `${key}-${childIndex}`)
          : documentNodes([child], width, frames, scroll, lang, formulas, `${key}-${childIndex}`, images))}
      </Box>;
      case "quote": return <MarkdownBlock id={key} key={key} role="blockquote" markdownTone="quote"
        frame="bordered" borderShape="rounded" style={{ width: "100%", padding: 1, gap: 1 }}>
        {documentNodes(node.children, Math.max(1, width - 4), frames, scroll, lang, formulas, key, images)}
      </MarkdownBlock>;
      case "list": return <Box id={key} key={key} style={{ width: "100%", gap: 1 }}>
        {node.items.map((item, itemIndex) => {
          const marker = node.ordered ? `${node.start + itemIndex}.` : "•";
          const contentWidth = Math.max(1, width - getTextCellWidth(marker) - 1);
          return <Box key={itemIndex} style={{ direction: "row", width: "100%", gap: 1 }}>
            <Text>{marker}</Text>
            <Box style={{ width: contentWidth, minWidth: 0, flexShrink: 1, gap: 1 }}>
              {documentNodes(item, contentWidth, frames, scroll, lang, formulas, `${key}-${itemIndex}`, images)}
            </Box>
          </Box>;
        })}
      </Box>;
    }
  }).filter(node => node !== null);
}

function relayUnits(document: RelayDocument) { return [document.article, ...document.chunks]; }

function relayContent(document: RelayDocument, reading: RelayReading, width: number, frames: Readonly<Record<string, string>>,
  scroll: CellScrollState, lang: BlogPageModel["lang"], formulas: FormulaGeometryMap) {
  return <Box id="relay-document" style={{ width: "100%", gap: 1 }}>
    {relayUnits(document).map(unit => {
      const view = relayView(reading.views, unit.id);
      const prepared = view.mode === "original" ? undefined : prepareRelayText(relayText(unit, view.mode), width);
      const { text, spans } = prepared ?? { text: "", spans: [] };
      const label = view.mode === "original" ? "返回" : unit.id === "article" ? "全文原文" : "原文";
      const showOriginal = !reading.canHover || reading.hovered === unit.id || reading.focused === unit.id;
      return <Fragment key={unit.id}><Box id={`relay-item:${unit.id}`} style={{ width: "100%", gap: 0 }}>
        <Box style={{ direction: "row", width: "100%" }}>
          <Box style={{ flexGrow: 1 }} />
          <Button id={`relay-original:${unit.id}`} label={label} variant={showOriginal ? "solid" : "ghost"}
            style={{ padding: 0, paddingLeft: 1, paddingRight: 1, width: getTextCellWidth(label) + 2 }}>
            <Text>{showOriginal ? label : " ".repeat(getTextCellWidth(label))}</Text>
          </Button>
        </Box>
        {view.mode === "original" ? <Box id={`relay-original-body:${unit.id}`} style={{ width: "100%", gap: 1 }}>
          {documentNodes(unit.original, width, frames, scroll, lang, formulas, `relay-original-${unit.id}`, reading.images)}
        </Box> : <Fragment>
          <Text id={`relay-text:${unit.id}`} style={{ width: "100%", height: prepared?.rows }}
            textStyleSpans={spans.map(span => ({ ...span, style: relaySpanStyle(span, reading.colors) }))}>{text}</Text>
          {unit.id !== "article" && documentNodes(articleImages(unit.original), width, frames, scroll, lang, formulas,
            `relay-reading-${unit.id}`, reading.images)}
        </Fragment>}
      </Box>{unit.id === "article" && document.chunks.length > 0 ? <Markdown id="relay-section-divider" source="---" /> : null}</Fragment>;
    })}
  </Box>;
}

function postLink(post: PostCard, showType = false) {
  return <Box key={post.href} style={{ direction: "row", width: "100%", gap: 1, wrap: true }}>
    <Text textStyle={{ dim: true }}>{post.date}</Text>
    {showType ? <Text textStyle={{ dim: true }}>{post.kind}</Text> : null}
    <Link id={`post-${post.href}`} href={post.href}>{post.title}</Link>
  </Box>;
}

function bodyFor(model: BlogPageModel, width: number, frames: Readonly<Record<string, string>>, scroll: CellScrollState,
  headings: readonly HeadingNode[], inlineToc: boolean, activeId: string | null,
  selectedStyle: typeof CLASSIC_MAC_LIGHT_THEME.selectedStyle, formulas: FormulaGeometryMap, reading: RelayReading) {
  if (model.kind === "home") {
    return <Box id="blog-body" style={{ width: "100%", gap: 1 }}>
      <Markdown source={`# ${model.title}\n\n${model.description}`} />
      {model.products?.length ? <Box style={{ width: "100%", gap: 1 }}>
        <Markdown source="## Products" />
        <Box style={{ direction: "row", width: "100%", gap: 2, wrap: true }}>
          {model.products.map(({ name, href }) => <Link key={href} id={href} href={href}>{name}</Link>)}
        </Box>
      </Box> : null}
      <Markdown source="## Sources" />
      {model.posts.map((post) => postLink(post))}
    </Box>;
  }
  if (model.kind === "listing") {
    const groups = model.grouped ? model.posts.filter((post) => post.category).reduce((map, post) => {
      const category = post.category!;
      map.set(category, [...(map.get(category) ?? []), post]);
      return map;
    }, new Map<string, PostCard[]>()) : null;
    return <Box id="blog-body" style={{ width: "100%", gap: 1 }}>
      <Markdown source={`# ${model.title}`} />
      {groups ? model.posts.filter((post) => !post.category).map((post) => postLink(post, model.showType)) : null}
      {groups ? [...groups].map(([name, posts]) => <Box key={name} style={{ width: "100%", gap: 1 }}>
        <Markdown source={`## ${name}`} />
        {posts.map((post) => postLink(post, model.showType))}
      </Box>) : model.posts.map((post) => postLink(post, model.showType))}
      {!model.posts.length ? <Text>{model.emptyText}</Text> : null}
    </Box>;
  }
  if (model.kind === "about") return <Box id="blog-body" style={{ width: "100%", gap: 1 }}>
    <Markdown source={`# ${model.title}\n\nHi`} />
  </Box>;
  if (model.kind === "not-found") return <Box id="blog-body" style={{ width: "100%", gap: 1 }}>
    <Markdown source="# Page not found\n\nThe requested page does not exist." />
    <Link href="/">Home →</Link>
  </Box>;
  return <Box id="blog-body" style={{ width: "100%", gap: model.relay ? 0 : 1 }}>
    <Box style={{ direction: "row", width: "100%", justify: "end", gap: 2, wrap: true }}>
      <Link href={model.sourceUrl}>{`${model.publisher ?? "Original"} ↗`}</Link>
      <Text textStyle={{ dim: true }}>{model.date}</Text>
    </Box>
    {inlineToc ? tocContent(headings, model.lang, activeId, width, selectedStyle) : null}
    {model.relay ? relayContent(model.relay, reading, width, frames, scroll, model.lang, formulas)
      : documentNodes(model.document, width, frames, scroll, model.lang, formulas, "doc", reading.images)}
  </Box>;
}

function pageHeader(model: BlogPageModel, width: number, mode: "light" | "dark") {
  const showTheme = model.appearance !== "light" && model.appearance !== "dark";
  const topRows = 1;
  const homeWidth = getTextCellWidth("Home");
  const themeWidth = 3;
  const translationWidth = 2;
  const titleWidth = Math.max(1, width - homeWidth - 1 - (showTheme ? themeWidth + 1 : 0)
    - (model.translationUrl ? translationWidth + 1 : 0));
  const titleRows: string[] = [];
  if (model.kind === "post") {
    const flow = layoutMarkdownInlineFlow([{ text: model.title, style: {} }], titleWidth);
    for (const glyph of flow.glyphs) titleRows[glyph.y] = (titleRows[glyph.y] ?? "") + glyph.text;
  }
  const content = <Root id="blog-header" style={{ direction: "row", width: "100%", gap: 1, paddingTop: topRows }}>
    <Link href="/" style={{ width: homeWidth, height: 1, flexShrink: 0 }} textStyle={{ bold: true }}>Home</Link>
    {model.kind === "post" ? <MarkdownBlock id="blog-article-title" role="heading" level={1} label={model.title}
      style={{ width: titleWidth, minWidth: 0, gap: 0 }}>
      {titleRows.map((value, row) => {
        const text = value.trimEnd();
        const inset = Math.max(0, Math.floor((titleWidth - getTextCellWidth(text)) / 2));
        return <Text key={row} style={{ height: 1 }} markdownTone="accent" textStyle={{ bold: true }}>{" ".repeat(inset) + text}</Text>;
      })}
    </MarkdownBlock> : <Box style={{ flexGrow: 1 }} />}
    {model.translationUrl ? <Link id="blog-translate" href={model.translationUrl}
      label={model.lang === "zh-CN" ? "Read in English" : "Read in Chinese"}
      style={{ width: translationWidth, height: 1 }}>{"  "}</Link> : null}
    {showTheme ? <Button id="blog-theme" label={mode === "light" ? "Dark mode" : "Light mode"} variant="ghost"
      style={{ width: themeWidth, height: 1 }}><Text>{mode === "light" ? "◐" : "◑"}</Text></Button> : null}
  </Root>;
  const translationRect = model.translationUrl
    ? { x: homeWidth + titleWidth + 2, y: topRows, width: translationWidth, height: 1 }
    : null;
  return { content, rows: topRows + Math.max(1, titleRows.length), translationRect };
}

function pageContent(model: BlogPageModel, width: number, mode: "light" | "dark", frames: Readonly<Record<string, string>>,
  scroll: CellScrollState, headings: readonly HeadingNode[], inlineToc: boolean, activeId: string | null,
  formulas: FormulaGeometryMap, reading: RelayReading): ReactElement<RootProps> {
  const selectedStyle = mode === "dark" ? CLASSIC_MAC_DARK_THEME.selectedStyle : CLASSIC_MAC_LIGHT_THEME.selectedStyle;
  return <Root id="blog-root" style={{ width: "100%" }}><Box id="blog-content" style={{ width: "100%", gap: 2 }}>
    {bodyFor(model, width, frames, scroll, headings, inlineToc, activeId, selectedStyle, formulas, reading)}
    <Box id="blog-footer" style={{ width: "100%", gap: 1 }}>
      <Text textStyle={{ dim: true }}>────────────────</Text>
      <Box style={{ direction: "row", wrap: true, gap: 2 }}>
        <Text>{`© ${new Date().getFullYear()} Relay`}</Text>
        <Link id="blog-rss" href="/feed.xml"
          label="RSS" style={{ width: 2, height: 1 }}>{"  "}</Link>
      </Box>
    </Box>
  </Box></Root>;
}

type DynamicSpec = Readonly<{ key: string; node: Extract<CellDocumentNode, { kind: "animation" | "demo" }> }>;
function dynamicNodes(nodes: readonly CellDocumentNode[], path = "doc"): DynamicSpec[] {
  return nodes.flatMap((node, index) => {
    const key = `${path}-${index}`;
    if (node.kind === "animation" || node.kind === "demo") return [{ key, node }];
    if (node.kind === "center") return node.children.flatMap((child, childIndex) => dynamicNodes([child], `${key}-${childIndex}`));
    if (node.kind === "quote") return dynamicNodes(node.children, key);
    if (node.kind === "list") return node.items.flatMap((item, itemIndex) => dynamicNodes(item, `${key}-${itemIndex}`));
    return [];
  });
}

export default function CellBlogApp({ model }: Readonly<{ model: BlogPageModel }>) {
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [relayViews, setRelayViews] = useState<RelayViews>({});
  const [relayMorphs, setRelayMorphs] = useState<RelayMorphs>({});
  const [imageSizes, setImageSizes] = useState<ImageSizes>({});
  const [expandedImage, setExpandedImage] = useState<ArticleImagePreview | null>(null);
  const [relayCanHover, setRelayCanHover] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const [relayHovered, setRelayHovered] = useState<string | null>(null);
  const [relayKeyboard, setRelayKeyboard] = useState(false);
  const [relayKeyboardUnit, setRelayKeyboardUnit] = useState<string | null>(null);
  const relaySequence = useRef(0);
  const relayScrollAnchor = useRef<{ target: string; offset: number } | null>(null);
  const readers = useMemo(() => model.kind === "post" && model.relay ? relayUnits(model.relay) : [], [model]);
  const [width, setWidth] = useState(72);
  useEffect(() => {
    if (!readers.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const idle = typeof window.requestIdleCallback === "function";
    let index = 0;
    let task = 0;
    const schedule = () => {
      task = idle ? window.requestIdleCallback(prepareUnit, { timeout: 600 }) : window.setTimeout(prepareUnit, 30);
    };
    const prepareUnit = () => {
      const unit = readers[index++]!;
      prepareCellMorph(prepareRelayText(unit.brief, width), prepareRelayText(unit.interpretation, width));
      if (index < readers.length) schedule();
    };
    schedule();
    return () => idle ? window.cancelIdleCallback(task) : window.clearTimeout(task);
  }, [readers, width]);
  const [formulaGeometry, setFormulaGeometry] = useState<FormulaGeometryMap>({});
  const [wideToc, setWideToc] = useState(() => window.innerWidth >= TOC_BREAKPOINT);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [preference, setPreference] = useState<"light" | "dark" | null>(() => {
    try { const value = localStorage.getItem("site-theme"); return value === "light" || value === "dark" ? value : null; }
    catch { return null; }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [headerFocusId, setHeaderFocusId] = useState<string | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => { setRelayCanHover(query.matches); setRelayHovered(null); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const scrollState = useCellScrollState();
  const scroll = useMemo(() => scrollState, [scrollState.offset, scrollState.dispatch]);
  const headings = useMemo(() => model.kind === "post" ? documentHeadings(model.document) : [], [model]);
  useLayoutEffect(() => {
    if (model.kind !== "post") return;
    let live = true;
    const measure = () => { if (live) setFormulaGeometry(measureDocumentFormulas(model.document, DEFAULT_CELL_UI_METRICS)); };
    measure();
    void document.fonts.ready.then(measure);
    return () => { live = false; };
  }, [model]);
  const hasToc = headings.length >= 2;
  const inlineToc = hasToc && !wideToc;
  const [dynamicFrames, setDynamicFrames] = useState<Readonly<Record<string, string>>>({});
  const dynamicFramesRef = useRef(dynamicFrames);
  dynamicFramesRef.current = dynamicFrames;
  const [selection, setSelection] = useState<DocumentSelection | null>(null);
  const selectionRef = useRef<DocumentSelection | null>(null);
  const gestureAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const [nativeRange, setNativeRange] = useState<CellRangeSnapshot | null>(null);
  const selectionBuffersRef = useRef(new Map<string, { source: string; buffer: ReturnType<typeof mediaCellBuffer> }>());
  const pauseRef = useRef<{ started: number | null; elapsed: number }>({ started: null, elapsed: 0 });
  const clearSelection = () => {
    selectionRef.current = null;
    gestureAnchorRef.current = null;
    setSelection(null);
    setNativeRange(null);
    const pause = pauseRef.current;
    if (pause.started !== null) {
      pause.elapsed += Date.now() - pause.started;
      pause.started = null;
    }
  };
  const [expandedMediaKey, setExpandedMediaKey] = useState<string | null>(null);
  const mediaViewerWasOpen = useRef(false);
  const dynamicSpecs = useMemo(() => model.kind === "post" ? dynamicNodes(model.document) : [], [model]);
  const mediaSpecs = useMemo(() => model.kind === "post" ? collectFittedMedia(model.document, width) : [], [model, width]);
  const expandedMedia = mediaSpecs.find((media) => media.key === expandedMediaKey);
  useEffect(() => {
    if (expandedMediaKey && !expandedMedia) setExpandedMediaKey(null);
  }, [expandedMediaKey, expandedMedia]);
  useEffect(() => {
    if (expandedMediaKey) { mediaViewerWasOpen.current = true; return; }
    if (!mediaViewerWasOpen.current) return;
    mediaViewerWasOpen.current = false;
    requestAnimationFrame(() => hostRef.current?.querySelector<HTMLElement>("[data-cell-surface]")?.focus());
  }, [expandedMediaKey]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    content.inert = Boolean(expandedMedia);
    return () => { content.inert = false; };
  }, [expandedMedia]);
  const mode = model.appearance === "light" || model.appearance === "dark" ? model.appearance : preference ?? (systemDark ? "dark" : "light");
  const theme = relayThemes[mode];
  const header = useMemo(() => pageHeader(model, width, mode), [model, width, mode]);
  const headerHeight = header.rows * DEFAULT_CELL_UI_METRICS.cellHeight;
  const headingInset = headerHeight + 8;
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${TOC_BREAKPOINT}px)`);
    const update = () => setWideToc(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { document.body.style.setProperty("--blog-background", theme.background); }, [theme]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const next = Math.max(1, Math.floor(host.clientWidth / DEFAULT_CELL_UI_METRICS.cellWidth) - 2 * CELL_SURFACE_GUARD_CELLS);
      if (next !== width) clearSelection();
      setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [width]);
  const reading = useMemo(() => ({ views: relayViews, colors: theme.markdownColors, canHover: relayCanHover,
    images: { sizes: imageSizes },
    hovered: relayHovered, focused: relayKeyboard ? relayKeyboardUnit ?? (focusedId?.startsWith("relay-original:") ? focusedId.slice("relay-original:".length) : null) : null }),
    [relayViews, theme.markdownColors, relayCanHover, relayHovered, relayKeyboard, relayKeyboardUnit, focusedId, imageSizes]);
  const { layoutContent, imageSlots } = useMemo(() => {
    const imageSlots = new Map<string, readonly ArticleImageNode[]>();
    const layoutContent = pageContent(model, width, mode, {}, scroll, headings, inlineToc, null, formulaGeometry,
      { views: relayViews, colors: theme.markdownColors, canHover: true, hovered: null, focused: null,
        images: { sizes: imageSizes, slots: imageSlots } });
    return { layoutContent, imageSlots };
  }, [model, width, mode, scroll, headings, inlineToc, formulaGeometry, relayViews, theme.markdownColors, imageSizes]);
  const inlineActiveId = inlineToc ? activeHeadingId : null;
  const content = useMemo(() => pageContent(model, width, mode, dynamicFrames, scroll, headings, inlineToc, inlineActiveId, formulaGeometry, reading),
    [model, width, mode, dynamicFrames, scroll, headings, inlineToc, inlineActiveId, formulaGeometry, reading]);
  const measured = useMemo(() => {
    const { tree } = reconcileWidgetTree(undefined, createWidgetDescriptor(layoutContent));
    const layout = new YogaLayoutEngine();
    try {
      const viewport = { width, height: 4096 };
      const entries = resolveCellUiScrollLayout(tree, viewport, { x: 0, y: 0, ...viewport }, layout).layout.entries;
      const clipFor = (id: string) => {
        let parentId = tree.nodes.get(id)?.parentId;
        while (parentId) {
          const parent = tree.nodes.get(parentId);
          if (parent?.kind === "scroll-area") return absoluteLayoutRect(entries, parentId) ?? undefined;
          parentId = parent?.parentId ?? undefined;
        }
        return undefined;
      };
      const formulaPlacements: FormulaPlacement[] = [];
      for (const node of tree.nodes.values()) {
        const rect = absoluteLayoutRect(entries, node.id);
        if (!rect) continue;
        if (node.kind === "formula" && node.formulaGeometry) {
          formulaPlacements.push({ key: node.id, source: node.text?.slice(2, -2) ?? "",
            geometry: node.formulaGeometry, rect, clip: clipFor(node.id) });
        }
        if (node.kind === "markdown-inline" && node.markdownInlineRuns) {
          const flow = layoutMarkdownInlineFlow(node.markdownInlineRuns, rect.width);
          for (const glyph of flow.glyphs) {
            if (!glyph.math) continue;
            formulaPlacements.push({ key: `${node.id}/inline-formula-${glyph.runIndex}`,
              source: glyph.math.source, geometry: glyph.math.geometry,
              rect: { x: rect.x + glyph.x, y: rect.y + glyph.y,
                width: glyph.width, height: glyph.math.geometry.rows }, clip: clipFor(node.id) });
          }
        }
      }
      return {
        height: Math.max(1, entries.get("blog-content")?.rect.height ?? 1),
        formulaPlacements,
        imagePlacements: [...imageSlots].flatMap(([key, nodes]) => {
          const rect = absoluteLayoutRect(entries, key);
          return rect ? [{ key, nodes, rect }] : [];
        }),
        positions: Object.fromEntries([...new Set([...ICON_LINKS.map(({ id }) => id), ...headings.map(({ id }) => id),
          ...dynamicSpecs.map(({ key }) => key), ...mediaSpecs.map(({ key }) => key), ...readers.flatMap(unit => [
            `relay-text:${unit.id}`, `relay-item:${unit.id}`, `relay-original:${unit.id}`,
          ])])]
          .map((key) => [key, absoluteLayoutRect(entries, key)]).filter(([, rect]) => rect).concat(readers.flatMap(unit => unit.anchors.map(anchor => {
            const target = relayHeadingTarget({ article: readers[0], chunks: readers.slice(1) }, relayViews, anchor);
            return [anchor, target ? absoluteLayoutRect(entries, target) : null];
          })))),
      };
    } finally { layout.dispose(); }
  }, [layoutContent, width, headings, dynamicSpecs, mediaSpecs, readers, relayViews, imageSlots]);
  const relayCopyRows = useMemo(() => {
    const rows = new Map<number, { left: number; line: RelayCopyLine }>();
    for (const unit of readers) {
      const rect = measured.positions[`relay-text:${unit.id}`];
      const view = relayView(relayViews, unit.id);
      if (!rect || view.mode === "original") continue;
      prepareRelayText(relayText(unit, view.mode), rect.width).copyLines.forEach((line, index) => {
        rows.set(rect.y + index, { left: rect.x, line });
      });
    }
    return rows;
  }, [measured.positions, readers, relayViews]);
  useLayoutEffect(() => {
    const anchor = relayScrollAnchor.current;
    if (!anchor) return;
    relayScrollAnchor.current = null;
    const host = hostRef.current;
    const rect = measured.positions[anchor.target];
    if (!host || !rect) return;

    const top = host.getBoundingClientRect().top + surfaceGuardHeight + rect.y * DEFAULT_CELL_UI_METRICS.cellHeight;
    const delta = top - (headingInset + anchor.offset);
    if (Math.abs(delta) >= 1) window.scrollTo({ top: window.scrollY + delta, behavior: "instant" });
  }, [headingInset, measured.positions, relayViews]);
  const positionsRef = useRef(measured.positions);
  positionsRef.current = measured.positions;
  const scrollToHeading = useCallback((id: string, behavior: ScrollBehavior = "auto") => {
    const rect = positionsRef.current[id];
    const host = hostRef.current;
    if (!rect || !host) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + host.getBoundingClientRect().top
      + surfaceGuardHeight + rect.y * DEFAULT_CELL_UI_METRICS.cellHeight - headingInset), behavior });
    if (behavior !== "smooth") setActiveHeadingId(id);
  }, [headingInset]);
  const navigateToHeading = (id: string) => {
    if (!headings.some((heading) => heading.id === id)) return;
    let currentHash = "";
    try { currentHash = decodeURIComponent(window.location.hash.slice(1)); } catch { /* Replace malformed hashes. */ }
    if (currentHash !== id) window.history.pushState(null, "", `#${id}`);
    scrollToHeading(id, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  };
  useEffect(() => {
    if (!hasToc) return;
    let frame = 0;
    const fromLocation = () => {
      let id: string;
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      if (headings.some((heading) => heading.id === id)) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => scrollToHeading(id));
      }
    };
    window.addEventListener("hashchange", fromLocation);
    window.addEventListener("popstate", fromLocation);
    fromLocation();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", fromLocation);
      window.removeEventListener("popstate", fromLocation);
    };
  }, [hasToc, headings, scrollToHeading]);
  useEffect(() => {
    if (!hasToc) return;
    let frame = 0;
    const update = () => {
      const host = hostRef.current;
      if (!host) return;
      const row = (headingInset + 8 - host.getBoundingClientRect().top - surfaceGuardHeight) / DEFAULT_CELL_UI_METRICS.cellHeight;
      let current: string | null = headings[0]?.id ?? null;
      for (const heading of headings) {
        const rect = positionsRef.current[heading.id];
        if (rect && rect.y <= row) current = heading.id;
      }
      setActiveHeadingId((previous) => previous === current ? previous : current);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); };
  }, [hasToc, headings, headingInset, measured.positions]);
  useEffect(() => {
    if (!dynamicSpecs.length) return;
    type Demo = { interval?: number; render: (elapsed: number) => string };
    const demos = new Map<string, Demo>();
    const pending = new Set<string>();
    const starts = new Map<string, number>();
    const lastTimes = new Map<string, number>();
    let live = true;
    const tick = () => {
      if (!live || document.visibilityState === "hidden" || pauseRef.current.started !== null) return;
      const host = hostRef.current;
      if (!host) return;
      const hostTop = host.getBoundingClientRect().top;
      const now = Date.now() - pauseRef.current.elapsed;
      const updates: Record<string, string> = {};
      for (const { key, node } of dynamicSpecs) {
        const rect = positionsRef.current[key];
        if (!rect) continue;
        const top = hostTop + rect.y * DEFAULT_CELL_UI_METRICS.cellHeight;
        const bottom = top + rect.height * DEFAULT_CELL_UI_METRICS.cellHeight;
        if (bottom < -window.innerHeight || top > window.innerHeight * 2) continue;
        if (!starts.has(key)) starts.set(key, now);
        const elapsed = now - starts.get(key)!;
        if (node.kind === "demo" && !demos.has(key)) {
          if (!pending.has(key)) {
            pending.add(key);
            void import(/* @vite-ignore */ node.source).then((module: { createAsciiDemo?: (options: unknown) => Demo }) => {
              if (!live) return;
              const demo = module.createAsciiDemo?.({ kind: node.name, api: cellDemoApi });
              if (!demo || typeof demo.render !== "function") throw new Error(`Invalid demo: ${node.name}`);
              demos.set(key, demo);
            }).catch((error) => console.error(`Failed to load ${node.name}`, error));
          }
          continue;
        }
        const interval = node.kind === "demo" ? node.interval : node.interval;
        if (now - (lastTimes.get(key) ?? 0) < interval) continue;
        lastTimes.set(key, now);
        if (node.kind === "animation") {
          updates[key] = node.frames[Math.floor(elapsed / interval) % Math.max(1, node.frames.length)] ?? "";
        } else {
          updates[key] = demoHtmlToProtocol(demos.get(key)!.render(elapsed));
        }
      }
      if (Object.keys(updates).length) setDynamicFrames((current) => {
        const changed = Object.entries(updates).some(([key, value]) => current[key] !== value);
        return changed ? { ...current, ...updates } : current;
      });
    };
    tick();
    const timer = window.setInterval(tick, 50);
    return () => { live = false; window.clearInterval(timer); };
  }, [dynamicSpecs]);
  const activateRelay = (id: string, original: boolean, pointerY?: number) => {
    const unit = readers.find(unit => unit.id === id);
    if (!unit) return;
    const before = relayView(relayViews, id);
    const next = changeRelayView(relayViews, id, original ? "original" : "toggle");
    if (next === relayViews) return;
    const after = relayView(next, id);
    const host = hostRef.current;
    const target = original ? `relay-original:${id}` : `relay-text:${id}`;
    const rect = measured.positions[target];
    let firstRow = 0;
    let visibleRows = Math.ceil(window.innerHeight / DEFAULT_CELL_UI_METRICS.cellHeight);
    if (host && rect) {
      const rowHeight = DEFAULT_CELL_UI_METRICS.cellHeight;
      const top = host.getBoundingClientRect().top + surfaceGuardHeight + rect.y * rowHeight;
      const lastVisibleRow = Math.max(headingInset, window.innerHeight - rowHeight);
      const visible = top >= headingInset && top <= lastVisibleRow;
      const screenY = visible ? top : Math.min(lastVisibleRow, Math.max(headingInset, pointerY ?? headingInset));
      relayScrollAnchor.current = { target, offset: screenY - headingInset };
      visibleRows = Math.max(1, Math.ceil((window.innerHeight - screenY) / rowHeight));
      if (visible && pointerY !== undefined) firstRow = Math.max(0, Math.floor((pointerY - top) / rowHeight));
    }
    clearSelection();
    setRelayViews(next);
    const animate = !original && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transition = animate
      ? { from: relayText(unit, before.mode), to: relayText(unit, after.mode), firstRow, visibleRows, sequence: ++relaySequence.current }
      : undefined;
    setRelayMorphs(previous => {
      if (!transition && !previous[id]) return previous;
      const result = { ...previous };
      if (transition) result[id] = transition;
      else delete result[id];
      return result;
    });
  };
  const onCommand = (command: WidgetCommand) => {
    scroll.dispatch(command);
    if (command.type === "focus") setFocusedId(command.targetId);
    if (command.type === "activate" && command.targetId.startsWith("relay-original:")) {
      activateRelay(command.targetId.slice("relay-original:".length), true);
      return;
    }
    if (command.type === "activate" && command.targetId.startsWith("media-expand:")) {
      setExpandedMediaKey(command.targetId.slice("media-expand:".length));
      setFocusedId(command.targetId);
    }
    if (command.type === "activate" && command.targetId === "blog-theme") {
      const next = mode === "light" ? "dark" : "light";
      setPreference(next);
      try { localStorage.setItem("site-theme", next); } catch { /* In-memory theme remains usable. */ }
    }
    if (command.type === "open-link") {
      if (command.href.startsWith("#section-") && headings.some((heading) => `#${heading.id}` === command.href)) {
        navigateToHeading(command.href.slice(1));
        return;
      }
      if (command.href === model.translationUrl) {
        try { localStorage.setItem("site-lang", model.lang === "en" ? "zh-CN" : "en"); } catch { /* Navigation still works. */ }
      }
      if (command.target === "_blank") window.open(command.href, "_blank", "noopener,noreferrer");
      else window.location.assign(command.href);
    }
  };
  const closeMediaViewer = () => {
    setExpandedMediaKey(null);
  };
  const onSelectionGesture = (gesture: Readonly<{
    phase: "start" | "move" | "end";
    shape: "linear" | "rectangle";
    anchor: Readonly<{ x: number; y: number }>;
    head: Readonly<{ x: number; y: number }>;
    bounds: DOMRect;
    buffer: import("@/lib/cell-ui/buffer").CellBuffer;
  }>) => {
    if (gesture.phase === "start" && pauseRef.current.started === null) pauseRef.current.started = Date.now();
    if (gesture.phase === "start") gestureAnchorRef.current = {
      x: gesture.anchor.x - gesture.bounds.left, y: gesture.anchor.y - gesture.bounds.top,
    };
    const media: SelectionMedia[] = mediaSpecs.flatMap((item) => {
      const rect = positionsRef.current[item.key];
      if (!rect) return [];
      const source = mediaSource(item.node, item.key, dynamicFramesRef.current);
      let cached = selectionBuffersRef.current.get(item.key);
      if (!cached || cached.source !== source || cached.buffer.width !== item.width || cached.buffer.height !== item.rows) {
        cached = { source, buffer: mediaCellBuffer(source, item.width, item.rows) };
        selectionBuffersRef.current.set(item.key, cached);
      }
      return [{ key: item.key, source, width: item.width, rows: item.rows,
        scale: item.scale, rect, buffer: cached.buffer }];
    });
    const selected = selectDocumentText({ shape: gesture.shape,
      anchor: gestureAnchorRef.current ?? {
        x: gesture.anchor.x - gesture.bounds.left, y: gesture.anchor.y - gesture.bounds.top,
      },
      head: { x: gesture.head.x - gesture.bounds.left, y: gesture.head.y - gesture.bounds.top },
      buffer: gesture.buffer, media, relayRows: relayCopyRows, cellWidth: DEFAULT_CELL_UI_METRICS.cellWidth,
      cellHeight: DEFAULT_CELL_UI_METRICS.cellHeight, guard: CELL_SURFACE_GUARD_CELLS });
    selectionRef.current = selected;
    setSelection(selected);
  };
  return <main className="cell-blog-page">
    <div className="cell-blog-content" ref={contentRef}
      style={{ "--blog-surface-guard": `${surfaceGuardHeight}px`, "--blog-header-height": `${headerHeight}px` } as CSSProperties}>
      <header className="cell-blog-header">
        <div className="cell-blog-header-ink">
          <CellSurface className="cell-blog-surface" label="Relay header" probeId="blog-header" viewport={{ width, height: header.rows }}
            theme={theme} fontProfile={fontProfile} metrics={DEFAULT_CELL_UI_METRICS}
            focusedId={headerFocusId} onCommand={command => {
              if (command.type === "focus") setHeaderFocusId(command.targetId);
              else onCommand(command);
            }}>{header.content}</CellSurface>
          {header.translationRect ? <IconInk id="blog-translate" source="/assets/icons/Translate.svg"
            rect={header.translationRect} color={theme.foreground} /> : null}
        </div>
      </header>
    <div className="cell-blog-layout">
    <div className={model.kind === "post" ? "cell-blog-host cell-blog-host--post" : "cell-blog-host"} ref={hostRef}
      data-relay-reading={readers.length > 0 || undefined}
      onPointerMove={event => {
        if (!relayCanHover || event.pointerType === "touch") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / DEFAULT_CELL_UI_METRICS.cellWidth - CELL_SURFACE_GUARD_CELLS;
        const y = (event.clientY - bounds.top) / DEFAULT_CELL_UI_METRICS.cellHeight - CELL_SURFACE_GUARD_CELLS;
        const unit = readers.find(unit => {
          const rect = measured.positions[`relay-item:${unit.id}`];
          return rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        });
        setRelayHovered(unit?.id ?? null);
      }}
      onPointerLeave={() => setRelayHovered(null)}
      onPointerDownCapture={() => setRelayKeyboard(false)}
      onKeyDownCapture={() => setRelayKeyboard(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) { setRelayKeyboard(false); setRelayKeyboardUnit(null); }
      }}
      onClick={event => {
      if (event.detail > 1 || selectionRef.current?.text) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / 9 - 1;
      const y = (event.clientY - bounds.top) / 20 - 1;
      const unit = readers.find(unit => {
        if (relayView(relayViews, unit.id).mode === "original") return false;
        const rect = measured.positions[`relay-text:${unit.id}`];
        return rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      });
      if (unit) activateRelay(unit.id, false, event.clientY);
    }}>
    <CellSurface key={width} className="cell-blog-surface" label="Relay" probeId="blog" viewport={{ width, height: measured.height }}
      theme={theme} palette={{ color: theme.foreground, background: theme.background }}
      fontProfile={fontProfile} metrics={DEFAULT_CELL_UI_METRICS} linearSelection
      cellRange={nativeRange}
      cellRangePaintSpans={selection?.hostSpans ?? EMPTY_HOST_RANGE_SPANS}
      onSelectionGesture={onSelectionGesture}
      resolveSelectionCopyText={() => selectionRef.current?.text}
      onCellRangeCommand={(command) => {
        if (command.type === "clear") clearSelection();
        else setNativeRange(command.snapshot);
      }}
      focusedId={focusedId} onCommand={onCommand}>{content}</CellSurface>
    {readers.map(unit => {
      const rect = measured.positions[`relay-text:${unit.id}`];
      const view = relayView(relayViews, unit.id);
      return rect && view.mode !== "original" ? <button key={unit.id} type="button" className="relay-keyboard-target" data-relay-toggle={unit.id}
        onFocus={() => { setRelayKeyboard(true); setRelayKeyboardUnit(unit.id); }} onBlur={() => setRelayKeyboardUnit(null)}
        aria-label={`${unit.id === "article" ? "全文：" : ""}${view.mode === "brief" ? "展开解读" : "折叠为简要"}：${prepareRelayText(unit.brief, rect.width).copyLines[0]?.source.slice(0, 40) ?? ""}`}
        aria-expanded={view.mode === "interpretation"} style={{ left: (rect.x + 1) * 9, top: (rect.y + 1) * 20, width: rect.width * 9, height: rect.height * 20 }}
        onClick={event => { event.stopPropagation(); activateRelay(unit.id, false); }} /> : null;
    })}
    {readers.flatMap(unit => {
      const rect = measured.positions[`relay-text:${unit.id}`];
      const view = relayView(relayViews, unit.id);
      if (!rect || view.mode === "original" || relayMorphs[unit.id]) return [];
      const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
      const guard = CELL_SURFACE_GUARD_CELLS;
      return Array.from(prepareRelayText(relayText(unit, view.mode), rect.width).links, ([link, boxes], index) => {
        const heading = link.href.startsWith("#section-") ? headings.find(({ id }) => link.href === `#${id}`) : undefined;
        return <a className="relay-inline-link" key={`${unit.id}:${index}`} href={link.href}
          target={heading ? undefined : "_blank"} rel={heading ? undefined : "noopener noreferrer"}
          aria-label={link.label} onClick={event => {
            event.stopPropagation();
            if (heading && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              navigateToHeading(heading.id);
            }
          }}>
          {boxes.map(box => <span key={box.row} style={{ left: (rect.x + box.column + guard) * cellWidth,
            top: (rect.y + box.row + guard) * cellHeight, width: box.width * cellWidth, height: cellHeight }} />)}
        </a>;
      });
    })}
    {Object.entries(relayMorphs).map(([id, transition]) => {
      const rect = measured.positions[`relay-text:${id}`];
      if (!rect) return null;
      const plan = prepareCellMorph(prepareRelayText(transition.from, rect.width), prepareRelayText(transition.to, rect.width));
      return <RelayMorph key={`${id}:${transition.sequence}`} plan={plan} transition={transition} rect={rect} color={theme.foreground} background={theme.background}
        fontProfile={fontProfile} metrics={DEFAULT_CELL_UI_METRICS} colors={theme.markdownColors}
        onComplete={() => setRelayMorphs(previous => {
          if (previous[id]?.sequence !== transition.sequence) return previous;
          const next = { ...previous }; delete next[id]; return next;
        })} />;
    })}
    <div className="cell-blog-math-layer" aria-hidden="true">
      {measured.formulaPlacements.map((placement) => <FormulaInk key={placement.key} placement={placement} color={theme.foreground} />)}
    </div>
    <div className="cell-blog-icon-layer" aria-hidden="true">
      {ICON_LINKS.map(({ id, source }) => {
        const rect = measured.positions[id];
        return rect ? <IconInk key={id} id={id} source={source} rect={rect} color={theme.foreground} /> : null;
      })}
    </div>
    {measured.imagePlacements.map(({ key, nodes, rect }) => {
      const onSize = (src: string, size: ImageSizes[string]) =>
        setImageSizes(previous => previous[src] ? previous : { ...previous, [src]: size });
      return nodes.length > 1
        ? <ArticleImageCarousel key={key} nodes={nodes} rect={rect} lang={model.lang} theme={theme} fontProfile={fontProfile}
          onOpen={setExpandedImage} onSize={onSize} />
        : <ArticleImage key={`${key}:${nodes[0]!.src}`} node={nodes[0]!} rect={rect} onOpen={setExpandedImage} onSize={onSize} />;
    })}
    {mediaSpecs.map((media) => {
      const rect = measured.positions[media.key];
      return rect ? <FittedMediaCanvas key={media.key} media={media} rect={rect}
        source={mediaSource(media.node, media.key, dynamicFrames)} background={theme.background} foreground={theme.foreground}
        selection={selection} rangeStyle={theme.rangeStyle} /> : null;
    })}
    </div>
    {wideToc && hasToc ? <ReadingRuler lang={model.lang} label={model.lang === "zh-CN" ? "本页目录" : "On This Page"}
      chapters={headings} positions={measured.positions} articleHeight={measured.height} articleRef={hostRef}
      activeId={activeHeadingId} theme={theme} fontProfile={fontProfile} onNavigate={navigateToHeading} /> : null}
  </div>
  </div>
    {expandedMedia ? <MediaViewer media={expandedMedia} source={mediaSource(expandedMedia.node, expandedMedia.key, dynamicFrames)}
      lang={model.lang} theme={theme} onClose={closeMediaViewer} /> : null}
    {expandedImage ? <ArticleImageViewer preview={expandedImage} onClose={() => setExpandedImage(null)} /> : null}
  </main>;
}
