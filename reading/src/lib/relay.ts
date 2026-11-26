import type { RelayUnit, RelayViews, RelayMode, RelayDocument } from '../components/cell/model';
import type { CellMarkdownColors } from './cell-ui/theme';
import { layoutRelay, type RelayInlineStyle } from './relay-layout.ts';

export type { RelayInlineStyle } from './relay-layout.ts';
export { layoutRelay as relayInline } from './relay-layout.ts';

export function relayView(views: RelayViews, id: string) {
  return views[id] ?? { mode: 'brief' as const, readable: 'brief' as const };
}

export function changeRelayView(views: RelayViews, id: string, action: 'toggle' | 'original'): RelayViews {
  const previous = relayView(views, id);
  if (action === 'original') return { ...views, [id]: previous.mode === 'original' ? { ...previous, mode: previous.readable } : { ...previous, mode: 'original' } };
  if (previous.mode === 'original') return views;
  const mode = previous.mode === 'brief' ? 'interpretation' : 'brief';
  return { ...views, [id]: { mode, readable: mode } };
}

export function relayText(unit: RelayUnit, mode: RelayMode) {
  return mode === 'original' ? unit.originalText : unit[mode];
}

export function relaySpanStyle(span: RelayInlineStyle, colors: CellMarkdownColors) {
  return { bold: span.bold, underline: Boolean(span.link),
    color: span.code ? colors.codeForeground : span.link ? colors.link : span.bold ? colors.strong : colors.quote };
}

export function relayLinkRegions(source: string, width: number) {
  return prepareRelayText(source, width).links;
}

type PreparedRelayText = ReturnType<typeof layoutRelay>;
const preparedRelayText = new Map<string, PreparedRelayText>();

export function prepareRelayText(source: string, width: number) {
  const key = `${width}:${source}`;
  const cached = preparedRelayText.get(key);
  if (cached) return cached;
  const result = layoutRelay(source, width);
  if (preparedRelayText.size >= 160) preparedRelayText.delete(preparedRelayText.keys().next().value!);
  preparedRelayText.set(key, result);
  return result;
}

export function relayHeadingTarget(document: RelayDocument, views: RelayViews, anchor: string) {
  const unit = document.chunks.find(unit => unit.anchors.includes(anchor));
  if (!unit) return undefined;
  const shown = relayView(views, 'article').mode === 'original' ? document.article : relayView(views, unit.id).mode === 'original' ? unit : undefined;
  if (!shown) return `relay-item:${unit.id}`;
  const index = shown.original.findIndex(node => node.kind === 'heading' && node.id === anchor);
  return `relay-original-${shown.id}-${index}-${anchor}`;
}
