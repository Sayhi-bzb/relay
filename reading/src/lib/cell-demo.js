import { decodeCharDeskTextRuns, getTextCellWidth } from "@chardesk/protocol";

const clamp = (value) => Math.max(0, Math.min(255, Math.trunc(Number(value) || 0)));

export const cellDemoApi = Object.freeze({
  colorText(value, red, green, blue) {
    return this.styleText(value, { color: [red, green, blue] });
  },
  styleText(value, style = {}) {
    const css = [];
    const foreground = style.reverse ? style.backgroundColor : style.color;
    const background = style.reverse ? style.color : style.backgroundColor;
    if (Array.isArray(foreground)) css.push(`color: rgb(${foreground.map(clamp).join(", ")});`);
    if (Array.isArray(background)) css.push(`background-color: rgb(${background.map(clamp).join(", ")});`);
    if (style.bold) css.push("font-weight: 700;");
    if (style.dim) css.push("opacity: 0.72;");
    if (style.italic) css.push("font-style: italic;");
    if (style.underline || style.strike) css.push(`text-decoration: ${[style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ")};`);
    const escaped = this.escapeHtml(value);
    return css.length ? `<span style="${css.join(" ")}">${escaped}</span>` : escaped;
  },
  escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  },
});

export function styleCodes(style) {
  const values = Object.fromEntries(String(style).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const split = part.indexOf(":");
    return [part.slice(0, split).trim(), part.slice(split + 1).trim()];
  }));
  const codes = [];
  if (values["font-weight"] === "700") codes.push("1");
  if (values.opacity === "0.72") codes.push("2");
  if (values["font-style"] === "italic") codes.push("3");
  if (values["text-decoration"]?.includes("underline")) codes.push("4");
  if (values["text-decoration"]?.includes("line-through")) codes.push("9");
  for (const [name, prefix] of [["color", "38"], ["background-color", "48"]]) {
    const match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(values[name] ?? "");
    if (match) codes.push(`${prefix};2;${match.slice(1).join(";")}`);
  }
  return codes;
}

export function demoFrameSize(value) {
  const decoded = decodeCharDeskTextRuns(String(value), { syntax: "auto" });
  if (decoded.diagnostics.length) throw new Error(decoded.diagnostics.map((item) => item.message).join("; "));
  const lines = decoded.text.split("\n");
  return { rows: lines.length, width: Math.max(1, ...lines.map(getTextCellWidth)) };
}
