import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { CharDeskFontProfile } from '@chardesk/fonts';
import { getTextCellWidth } from '@chardesk/protocol';
import { Box, Button, INSTANT_CELL_FEEDBACK, Link, Root, Text } from '@/lib/cell-ui';
import { CELL_SURFACE_GUARD_CELLS, CellSurface, DEFAULT_CELL_UI_METRICS } from '@/lib/cell-ui/browser';
import { layoutMarkdownInlineFlow } from '@/lib/cell-ui/markdown-inline-flow';
import type { CellUiTheme } from '@/lib/cell-ui/theme';
import type { BlogLang } from './model';

type Chapter = { id: string; label: string };
const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
const guard = CELL_SURFACE_GUARD_CELLS;
const titleColumns = 18;
const articleGapColumns = 2;
const markWidth = 4;
const rowPrefix = 'ruler-position:';

const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

function readViewport(height: number) {
  const rows = Math.max(1, Math.floor(height / cellHeight) - 2 * guard);
  const scrollRange = Math.max(1, maxScroll());
  return { rows, progress: Math.round(Math.min(1, Math.max(0, window.scrollY / scrollRange)) * (rows - 1)) };
}

export default function ReadingRuler({ chapters, positions, articleHeight, articleRef, activeId, label, lang, theme, fontProfile, onNavigate }: {
  chapters: readonly Chapter[];
  positions: Readonly<Record<string, { y: number } | null>>;
  articleHeight: number;
  articleRef: RefObject<HTMLDivElement | null>;
  activeId: string | null;
  label: string;
  lang: BlogLang;
  theme: CellUiTheme;
  fontProfile: CharDeskFontProfile;
  onNavigate: (id: string) => void;
}) {
  const [{ rows, progress }, setViewport] = useState(() => readViewport(0));
  const [hovered, setHovered] = useState<{ row: number; chapterId?: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(titleColumns + markWidth);

  useLayoutEffect(() => {
    const article = articleRef.current;
    const rail = railRef.current;
    if (!article || !rail) return;
    const measure = () => {
      const available = rail.getBoundingClientRect().right - article.getBoundingClientRect().right;
      setWidth(Math.max(markWidth + 1, Math.floor(available / cellWidth) - articleGapColumns));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(article);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [articleRef]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const update = () => {
      const current = readViewport(rail.clientHeight);
      setViewport(previous => previous.rows === current.rows && previous.progress === current.progress ? previous : current);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    window.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(rail);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [articleHeight]);

  const marks = useMemo(() => {
    const placed = new Map<number, Chapter[]>();
    const targets = chapters.flatMap(chapter => {
      const rect = positions[chapter.id];
      return rect ? [{ chapter, row: Math.round(rect.y / articleHeight * (rows - 1)) }] : [];
    });
    const spacing = targets.length <= rows ? 1 : 0;
    let previous = -spacing;
    targets.forEach(({ chapter, row }, index) => {
      const top = Math.min(Math.max(row, previous + spacing), rows - 1 - (targets.length - index - 1) * spacing);
      placed.set(top, [...(placed.get(top) ?? []), chapter]);
      previous = top;
    });
    return placed;
  }, [chapters, positions, articleHeight, rows]);

  const selected = hovered ? hovered.chapterId : keyboard && focused?.startsWith('ruler:') ? focused.slice(6) : null;
  const selectedRow = [...marks].find(([, list]) => list.some(chapter => chapter.id === selected))?.[0];
  const selectedChapter = chapters.find(chapter => chapter.id === selected);
  const axisWidth = Math.min(width - 1, Math.max(1, ...[...marks.values()].map(list => list.length)) * markWidth);
  const titleWidth = width - axisWidth;
  const titleLines: string[] = [];
  if (selectedChapter) {
    const flow = layoutMarkdownInlineFlow([{ text: selectedChapter.label, style: {} }], titleWidth);
    for (const { text, y } of flow.glyphs) titleLines[y] = (titleLines[y] ?? '') + text;
  }
  const titleTop = Math.max(0, Math.min(selectedRow ?? 0, rows - titleLines.length));
  return <nav className="cell-blog-toc" ref={railRef} aria-label={label}
    style={{ width: (width + 2 * guard) * cellWidth, paddingLeft: guard * cellWidth }}
    onPointerMove={event => {
      if (event.pointerType === 'touch') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const row = Math.floor((event.clientY - bounds.top) / cellHeight) - guard;
      const column = Math.floor((bounds.right - event.clientX) / cellWidth);
      const chaptersAtRow = marks.get(row) ?? [];
      const index = chaptersAtRow.length - 1 - Math.floor(column / markWidth);
      const inside = row >= 0 && row < rows && column >= 0 && column < Math.max(markWidth, chaptersAtRow.length * markWidth);
      const chapterId = chaptersAtRow[index]?.id;
      setHovered(previous => inside ? previous?.row === row && previous.chapterId === chapterId ? previous : { row, chapterId } : null);
    }}
    onPointerLeave={() => setHovered(null)} onPointerDownCapture={() => setKeyboard(false)}
    onKeyDownCapture={() => setKeyboard(true)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboard(false); }}>
    <CellSurface className="cell-blog-toc-surface" label={label} probeId="blog-toc" viewport={{ width, height: rows }} theme={theme}
      palette={{ color: theme.foreground, background: theme.background }} fontProfile={fontProfile}
      metrics={DEFAULT_CELL_UI_METRICS} focusedId={focused} feedback={INSTANT_CELL_FEEDBACK}
      onCommand={command => {
        if (command.type === 'focus') setFocused(command.targetId);
        if (command.type === 'activate' && command.targetId.startsWith(rowPrefix)) {
          const row = Number(command.targetId.slice(rowPrefix.length));
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          window.scrollTo({ top: row / Math.max(1, rows - 1) * maxScroll(), behavior: reduce ? 'instant' : 'smooth' });
        }
        if (command.type === 'open-link' && command.href.startsWith('#section-')) onNavigate(command.href.slice(1));
      }}>
      <Root id="toc-ruler" style={{ width: '100%', gap: 0 }}>
        {Array.from({ length: rows }, (_, row) => {
          const chaptersAtRow = marks.get(row);
          const current = progress === row;
          const hover = hovered?.row === row;
          const title = titleLines[row - titleTop]?.trimEnd();
          const tickStyle = current ? { color: theme.markdownColors.strong } : undefined;
          const percentage = Math.round(row / Math.max(1, rows - 1) * 100);
          return <Box key={row} style={{ direction: 'row', height: 1, width: '100%', flexShrink: 0 }}>
            <Box style={{ width: titleWidth, height: 1, flexShrink: 0 }}>
              {title ? <Text>{title.padStart(title.length + Math.max(0, titleWidth - getTextCellWidth(title)))}</Text> : null}
            </Box>
            <Box style={{ direction: 'row', width: axisWidth, height: 1, flexShrink: 0 }}>
              <Box style={{ flexGrow: 1 }} />
              {chaptersAtRow ? chaptersAtRow.map((chapter, index) => {
                const activeTick = current && index === chaptersAtRow.length - 1;
                const highlighted = hover && hovered.chapterId === chapter.id;
                return <Link key={chapter.id} id={`ruler:${chapter.id}`} href={`#${chapter.id}`} label={chapter.label}
                  current={chapter.id === activeId ? 'location' : undefined} hoverFeedback={false} style={{ width: markWidth, height: 1 }}
                  textStyle={activeTick && !highlighted ? tickStyle : { color: theme.foreground }}>{activeTick || highlighted ? ' ╶──' : '  ╶─'}</Link>;
              }) : <Button id={`${rowPrefix}${row}`} label={lang === 'zh-CN' ? `滚动到 ${percentage}%` : `Scroll to ${percentage}%`}
                variant="ghost" hoverFeedback={false} style={{ width: markWidth, height: 1, padding: 0 }}
                textStyle={hover ? { color: theme.foreground } : tickStyle ?? { color: theme.secondaryStyle.color, dim: true }}>
                <Text>{current || hover ? ' ╶──' : '   ╶'}</Text>
              </Button>}
            </Box>
          </Box>;
        })}
      </Root>
    </CellSurface>
  </nav>;
}
