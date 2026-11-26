export type FormulaGeometry = Readonly<{
  columns: number;
  rows: number;
  ascentRows: number;
  descentRows: number;
  pixelWidth: number;
  pixelHeight: number;
  baselinePx: number;
  fontSizePx: number;
  topOffsetPx: number;
  html: string;
}>;

export type FormulaGeometryMap = Readonly<Record<string, FormulaGeometry>>;
export const formulaKey = (source: string, display: boolean) => `${display ? "block" : "inline"}\u0000${source}`;
export const formulaCopyText = (source: string, display: boolean) => display ? `$$${source}$$` : `$${source}$`;
