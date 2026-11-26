import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CharDeskFontProfile } from '@chardesk/fonts';
import { iterateGraphemes } from '@chardesk/protocol';
import { Button, INSTANT_CELL_FEEDBACK, Root, Text } from '@/lib/cell-ui';
import { CELL_SURFACE_GUARD_CELLS, CellSurface, DEFAULT_CELL_UI_METRICS } from '@/lib/cell-ui/browser';
import type { CellUiTheme } from '@/lib/cell-ui/theme';
import { articleImageStripWidth } from '@/lib/article-image-strip';
import type { CellDocumentNode, ImageDimensions, ImageSizes } from './model';

export type ArticleImageNode = Extract<CellDocumentNode, { kind: 'image' }>;
type ImageRect = { x: number; y: number; width: number; height: number };
export type ArticleImageLayout = { sizes: ImageSizes; slots?: Map<string, readonly ArticleImageNode[]> };
export type ArticleImagePreview = { node: ArticleImageNode; origin?: ImageRect };

function thumbnailRect(image: HTMLImageElement | null): ImageRect | undefined {
  if (!image?.naturalWidth || !image.naturalHeight) return undefined;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
}

export function articleImages(nodes: readonly CellDocumentNode[]): ArticleImageNode[] {
  return nodes.flatMap(node => {
    if (node.kind === 'image') return [node];
    if (node.kind === 'quote' || node.kind === 'center') return articleImages(node.children);
    if (node.kind === 'list') return node.items.flatMap(articleImages);
    return [];
  });
}

export function articleImageRows(available: number, size?: ImageDimensions) {
  const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
  const width = available * cellWidth;
  const height = size ? Math.min(width, size.width) * size.height / size.width : width * 9 / 16;
  return Math.max(1, Math.ceil(height / cellHeight));
}

type ImageActions = {
  onSize: (src: string, size: ImageDimensions) => void;
  onOpen: (preview: ArticleImagePreview) => void;
};

function imageSlotStyle(rect: ImageRect) {
  const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
  const guard = CELL_SURFACE_GUARD_CELLS;
  return { left: (rect.x + guard) * cellWidth, top: (rect.y + guard) * cellHeight,
    width: rect.width * cellWidth, height: rect.height * cellHeight };
}

export function ArticleImage({ node, rect, width, onSize, onOpen }: ImageActions & {
  node: ArticleImageNode;
  rect?: ImageRect;
  width?: number;
}) {
  const [failed, setFailed] = useState(false);
  const slot = rect ? imageSlotStyle(rect) : undefined;
  return <button type="button" className="cell-blog-article-image" data-article-image={node.src}
    aria-haspopup="dialog" aria-label={node.alt || node.caption || 'View image'}
    style={slot ?? { flexBasis: width }} onClick={event => {
      event.stopPropagation();
      onOpen({ node, origin: thumbnailRect(event.currentTarget.querySelector('img')) });
    }}>
    {failed ? <span>Image unavailable · View image</span> :
      <img src={node.src} alt={node.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        style={slot ? { width: node.size ? Math.min(node.size.width, slot.width) : '100%' } : undefined}
        onError={() => setFailed(true)} onLoad={({ currentTarget }) => {
          if (!node.size && currentTarget.naturalWidth && currentTarget.naturalHeight) {
            onSize(node.src, { width: currentTarget.naturalWidth, height: currentTarget.naturalHeight });
          }
        }} />}
  </button>;
}

function ImageStripControl({ direction, rows, theme, fontProfile, label, move }: {
  direction: 'previous' | 'next';
  rows: number;
  theme: CellUiTheme;
  fontProfile: CharDeskFontProfile;
  label: string;
  move: () => void;
}) {
  const id = useId();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { cellWidth, cellHeight } = DEFAULT_CELL_UI_METRICS;
  const guard = CELL_SURFACE_GUARD_CELLS;
  const height = Math.min(rows, 3);
  const overlayTheme = useMemo(() => ({ ...theme, background: 'transparent' }), [theme]);
  return <div className={`cell-blog-image-control cell-blog-image-control--${direction}`}
    style={{ width: 3 * cellWidth, height: height * cellHeight, top: Math.floor((rows - height) / 2) * cellHeight }}>
    <div style={{ marginLeft: -guard * cellWidth, marginTop: -guard * cellHeight }}>
      <CellSurface label={label} viewport={{ width: 3, height }} metrics={DEFAULT_CELL_UI_METRICS} fontProfile={fontProfile}
        theme={overlayTheme} feedback={INSTANT_CELL_FEEDBACK}
        focusedId={focusedId} onCommand={command => {
          if (command.type === 'focus') setFocusedId(command.targetId);
          if (command.type === 'activate' && command.targetId === id) move();
        }}>
        <Root>
          <Button id={id} label={label} variant="ghost" hoverFeedback={false}
            style={{ width: 3, height, padding: 0, paddingTop: Math.floor(height / 2) }}>
            <Text style={{ width: 3, height: 1 }} textStyle={{ color: theme.background, backgroundColor: theme.foreground }}>
              {direction === 'previous' ? ' ◂ ' : ' ▸ '}
            </Text>
          </Button>
        </Root>
      </CellSurface>
    </div>
  </div>;
}

export function ArticleImageCarousel({ nodes, rect, lang, theme, fontProfile, onOpen, onSize }: ImageActions & {
  nodes: readonly ArticleImageNode[];
  rect: ImageRect;
  lang: 'en' | 'zh-CN';
  theme: CellUiTheme;
  fontProfile: CharDeskFontProfile;
}) {
  const track = useRef<HTMLDivElement>(null);
  const chinese = lang === 'zh-CN';
  const slot = imageSlotStyle(rect);
  const [edges, setEdges] = useState({ previous: false, next: false });
  const updateEdges = (strip: HTMLDivElement) => {
    const previous = strip.scrollLeft > 1;
    const next = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1;
    setEdges(current => current.previous === previous && current.next === next ? current : { previous, next });
  };
  useLayoutEffect(() => {
    if (track.current) updateEdges(track.current);
  }, [nodes, slot.height, slot.width]);

  const move = (direction: 'previous' | 'next') => {
    const strip = track.current;
    if (!strip || !edges[direction]) return false;
    const end = strip.scrollWidth - strip.clientWidth;
    const stops = Array.from(strip.children, child => Math.min((child as HTMLElement).offsetLeft, end));
    const left = direction === 'next'
      ? stops.find(stop => stop > strip.scrollLeft + 1) ?? end
      : stops.findLast(stop => stop < strip.scrollLeft - 1) ?? 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollTo({ left, behavior: reduced ? 'instant' : 'smooth' });
    return true;
  };

  return <div className="cell-blog-image-carousel" style={{ ...slot, color: theme.foreground }} role="group"
    aria-label={chinese ? '文章图片组' : 'Article images'} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'ArrowLeft' && move('previous')) event.preventDefault();
      if (event.key === 'ArrowRight' && move('next')) event.preventDefault();
    }}>
    <div className="cell-blog-image-track" ref={track} style={{ gap: DEFAULT_CELL_UI_METRICS.cellWidth }}
      onScroll={event => updateEdges(event.currentTarget)}>
      {nodes.map((node, index) => <ArticleImage key={`${index}:${node.src}`} node={node}
        width={articleImageStripWidth(slot.width, slot.height, node.size)} onOpen={onOpen} onSize={onSize} />)}
    </div>
    {edges.previous && <ImageStripControl direction="previous" rows={rect.height} theme={theme} fontProfile={fontProfile}
      label={chinese ? '往左滑动图片组' : 'Scroll images left'} move={() => move('previous')} />}
    {edges.next && <ImageStripControl direction="next" rows={rect.height} theme={theme} fontProfile={fontProfile}
      label={chinese ? '往右滑动图片组' : 'Scroll images right'} move={() => move('next')} />}
  </div>;
}

export function ArticleImageViewer({ preview: { node, origin }, onClose }: { preview: ArticleImagePreview; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const caption = node.caption || node.alt;
  const glyphs = useMemo(() => Array.from(iterateGraphemes(caption), ({ segment }) => segment), [caption]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [entered, setEntered] = useState(false);
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    const overflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);

  useLayoutEffect(() => {
    if (state !== 'ready') return;
    const image = imageRef.current!;
    const target = image.getBoundingClientRect();
    if (!origin?.width || !origin.height || !target.width || !target.height ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setEntered(true);
      return;
    }
    const x = origin.x - target.x;
    const y = origin.y - target.y;
    const animation = image.animate([
      { transform: `translate(${x}px, ${y}px) scale(${origin.width / target.width}, ${origin.height / target.height})` },
      { transform: 'none' },
    ], { duration: 300, easing: 'cubic-bezier(0.2, 0.75, 0.3, 1)', fill: 'backwards' });
    animation.id = 'article-image-zoom';
    animation.onfinish = () => setEntered(true);
    return () => { animation.onfinish = null; animation.cancel(); };
  }, [origin, state]);

  useEffect(() => {
    if ((!entered && state !== 'error') || !glyphs.length) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) { setCount(glyphs.length); return; }
    const interval = Math.min(24, 1200 / glyphs.length);
    let frame = 0;
    const start = performance.now();
    const print = (time: number) => {
      const visible = Math.min(glyphs.length, Math.max(1, Math.floor((time - start) / interval) + 1));
      setCount(visible);
      if (visible < glyphs.length) frame = requestAnimationFrame(print);
    };
    const finish = () => {
      if (!motion.matches) return;
      cancelAnimationFrame(frame);
      setCount(glyphs.length);
    };
    frame = requestAnimationFrame(print);
    motion.addEventListener('change', finish);
    return () => { cancelAnimationFrame(frame); motion.removeEventListener('change', finish); };
  }, [entered, glyphs, state]);

  return <dialog className="cell-blog-image-viewer" ref={ref} aria-label="Image preview" data-image-settled={entered || state === 'error' ? '' : undefined}
    aria-describedby={caption ? 'article-image-caption' : undefined} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) ref.current?.close(); }}>
    <figure>
      <div className="cell-blog-image-stage" onClick={event => { if (event.target === event.currentTarget) ref.current?.close(); }}>
        {state === 'error' ? <a href={node.src}>Image unavailable · Open source image</a> :
          <img ref={imageRef} src={node.src} alt={node.alt} decoding="async" referrerPolicy="no-referrer"
            style={{ visibility: state === 'loading' ? 'hidden' : undefined }}
            onLoad={() => setState('ready')} onError={() => setState('error')} />}
      </div>
      {caption ? <figcaption className="cell-blog-image-caption">
        <span id="article-image-caption">{caption}</span>
        <span aria-hidden="true"><span data-image-caption-print>{glyphs.slice(0, count).join('')}</span>
          <span className="cell-blog-caption-unprinted">{glyphs.slice(count).join('')}</span></span>
      </figcaption> : null}
    </figure>
  </dialog>;
}
