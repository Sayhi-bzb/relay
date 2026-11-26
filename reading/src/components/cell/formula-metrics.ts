import katex from "katex";
import type { CharDeskCellMetrics } from "@chardesk/rendering";
import { formulaKey, type FormulaGeometry, type FormulaGeometryMap } from "@/lib/cell-ui/formula";
import type { CellDocumentNode } from "./model";

function formulasIn(nodes: readonly CellDocumentNode[]): ReadonlyArray<Readonly<{ source: string; display: boolean }>> {
  return nodes.flatMap((node): ReadonlyArray<Readonly<{ source: string; display: boolean }>> => {
    if (node.kind === "math") return [{ source: node.source, display: true }];
    if (node.kind === "markdown" || node.kind === "heading") return node.inlineMath.map((source) => ({ source, display: false }));
    if (node.kind === "quote" || node.kind === "center") return formulasIn(node.children);
    if (node.kind === "list") return node.items.flatMap(formulasIn);
    return [];
  });
}

export function measureDocumentFormulas(nodes: readonly CellDocumentNode[], metrics: CharDeskCellMetrics): FormulaGeometryMap {
  const unique = new Map(formulasIn(nodes).map((item) => [formulaKey(item.source, item.display), item]));
  if (!unique.size) return {};
  const host = document.createElement("div");
  host.className = "cell-blog-math-measure";
  document.body.append(host);
  const measured: Record<string, FormulaGeometry> = {};
  try {
    for (const [key, { source, display }] of unique) {
      let html: string;
      try { html = katex.renderToString(source, { output: "html", displayMode: display,
        throwOnError: true, trust: false }); }
      catch { continue; }
      const wrapper = document.createElement("span");
      wrapper.className = "cell-blog-math-ink";
      wrapper.innerHTML = html;
      const marker = document.createElement("span");
      marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      host.replaceChildren(wrapper, marker);
      const measureAt = (fontSizePx: number) => {
        wrapper.style.fontSize = `${fontSizePx}px`;
        const bounds = wrapper.getBoundingClientRect();
        return { bounds, baselinePx: display ? bounds.height : marker.getBoundingClientRect().top - bounds.top };
      };
      let fontSizePx = metrics.fontSize;
      const cellBaseline = metrics.baseline ?? metrics.cellHeight * 0.75;
      let { bounds, baselinePx } = measureAt(fontSizePx);
      if (!display) {
        const fitsCellRow = (height: number, baseline: number) => baseline <= cellBaseline
          && height - baseline <= metrics.cellHeight - cellBaseline;
        if (!fitsCellRow(bounds.height, baselinePx)) {
          let lower = 0;
          let upper = fontSizePx;
          for (let step = 0; step < 16; step++) {
            const candidate = (lower + upper) / 2;
            const sample = measureAt(candidate);
            if (fitsCellRow(sample.bounds.height, sample.baselinePx)) lower = candidate;
            else upper = candidate;
          }
          fontSizePx = lower;
          ({ bounds, baselinePx } = measureAt(fontSizePx));
        }
      }
      const ascentRows = display ? Math.max(1, Math.ceil(baselinePx / metrics.cellHeight)) : 1;
      const descentRows = 0;
      measured[key] = { html, pixelWidth: bounds.width, pixelHeight: bounds.height, baselinePx,
        fontSizePx, topOffsetPx: display ? 0 : cellBaseline - baselinePx,
        columns: Math.max(1, Math.ceil((bounds.width + 2) / metrics.cellWidth)),
        rows: ascentRows + descentRows, ascentRows, descentRows };
    }
  } finally { host.remove(); }
  return measured;
}
