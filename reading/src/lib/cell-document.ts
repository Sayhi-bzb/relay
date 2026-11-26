import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromHtml } from "hast-util-from-html";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import type { CellDocumentNode, ImageSizes } from "../components/cell/model";
import { splitAsciiAnimationFrames } from "./ascii-block.js";
import { cellDemoApi, demoFrameSize } from "./cell-demo.js";
import { demoHtmlToProtocol } from "./cell-demo-server.js";

type MdNode = {
  type: string;
  value?: string;
  lang?: string | null;
  depth?: number;
  alt?: string;
  url?: string;
  title?: string | null;
  ordered?: boolean;
  start?: number | null;
  children?: MdNode[];
  position?: { start: { offset?: number; line: number }; end: { offset?: number; line: number } };
};
type HtmlNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[] };
function position(node: MdNode, sourceLabel: string) {
  if (node.position?.start.offset === undefined || node.position.end.offset === undefined) {
    throw new Error(`${sourceLabel}: Markdown node has no source position`);
  }
  return [node.position.start.offset, node.position.end.offset] as const;
}

function raw(node: MdNode, source: string, sourceLabel: string) {
  const [start, end] = position(node, sourceLabel);
  return source.slice(start, end);
}

function inlineMathNodes(node: MdNode): MdNode[] {
  if (node.type === "inlineMath") return [node];
  return (node.children ?? []).flatMap(inlineMathNodes);
}

function markdownSource(node: MdNode, source: string, sourceLabel: string) {
  return raw(node, source, sourceLabel);
}

function headingLabel(node: MdNode): string {
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "text" || node.type === "inlineCode" || node.type === "inlineMath") return node.value ?? "";
  if (node.type === "break") return " ";
  return (node.children ?? []).map(headingLabel).join("");
}

type HeadingIds = { used: Set<string>; count: number; imageSizes: ImageSizes };
function headingId(label: string, ids: HeadingIds): string {
  ids.count += 1;
  const slug = label.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/gu, "") || `heading-${ids.count}`;
  const base = `section-${slug}`;
  let id = base;
  for (let suffix = 2; ids.used.has(id); suffix += 1) id = `${base}-${suffix}`;
  ids.used.add(id);
  return id;
}

function htmlElement(value: string): HtmlNode | undefined {
  const tree = fromHtml(value, { fragment: true }) as HtmlNode;
  return (tree.children ?? []).find((child) => child.type === "element");
}

function htmlAttribute(element: HtmlNode, name: string) {
  const value = element.properties?.[name];
  return typeof value === "string" ? value : undefined;
}

function isCenterOpen(node: MdNode) {
  if (node.type !== "html" || !node.value) return false;
  const element = htmlElement(node.value);
  return element?.tagName === "div" && htmlAttribute(element, "align") === "center" && !node.value.includes("</div>");
}
function isCenterClose(node: MdNode) { return node.type === "html" && node.value?.trim() === "</div>"; }

function containsImage(node: MdNode): boolean {
  return node.type === "image" || (node.children ?? []).some(containsImage);
}

function imageSource(value: string | undefined, postUrl: string) {
  if (!value || /[\p{Cc}\\]/u.test(value)) return undefined;
  if (/^https?:\/\//iu.test(value)) return URL.canParse(value) ? value : undefined;
  if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(value)) return undefined;
  const url = new URL(value, `https://blog.invalid${postUrl}`);
  return url.pathname + url.search + url.hash;
}

function paragraphWithImages(node: MdNode, source: string, postUrl: string, sourceLabel: string, imageSizes: ImageSizes): CellDocumentNode[] {
  const output: CellDocumentNode[] = [];
  const inline = (nodes: readonly MdNode[], prefix = "", suffix = "") => {
    let text: MdNode[] = [];
    const flush = () => {
      if (!text.length) return;
      const [start] = position(text[0]!, sourceLabel);
      const [, end] = position(text.at(-1)!, sourceLabel);
      const value = source.slice(start, end).trim();
      if (value) output.push({ kind: "markdown", source: prefix + value + suffix,
        inlineMath: text.flatMap(inlineMathNodes).map(math => math.value ?? ""), wideContent: false });
      text = [];
    };
    for (const child of nodes) {
      if (!containsImage(child)) { text.push(child); continue; }
      flush();
      if (child.type === "image") {
        const src = imageSource(child.url, postUrl);
        if (src) output.push({ kind: "image", src, alt: child.alt ?? "", caption: child.title ?? undefined,
          size: imageSizes[child.url ?? ""] ?? imageSizes[src] });
        else if (child.alt) output.push({ kind: "markdown", source: child.alt.replace(/[\\`*_[\]<>]/g, "\\$&"), inlineMath: [], wideContent: false });
      } else if (child.children?.length) {
        const [start, end] = position(child, sourceLabel);
        const [innerStart] = position(child.children[0]!, sourceLabel);
        const [, innerEnd] = position(child.children.at(-1)!, sourceLabel);
        inline(child.children, prefix + source.slice(start, innerStart), source.slice(innerEnd, end) + suffix);
      }
    }
    flush();
  };
  inline(node.children ?? []);
  return output;
}

function compileNodes(nodes: MdNode[], source: string, postUrl: string, sourceLabel: string, ids: HeadingIds): CellDocumentNode[] {
  const output: CellDocumentNode[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (isCenterOpen(node)) {
      let close = index + 1;
      while (close < nodes.length && !isCenterClose(nodes[close]!)) close++;
      if (close === nodes.length) throw new Error(`${sourceLabel}:${node.position?.start.line}: unclosed centered block`);
      output.push({ kind: "center", children: compileNodes(nodes.slice(index + 1, close), source, postUrl, sourceLabel, ids) });
      index = close;
      continue;
    }
    if (isCenterClose(node)) throw new Error(`${sourceLabel}:${node.position?.start.line}: unmatched centered block`);
    if (node.type === "code" && (node.lang === "chardesk" || node.lang === "ascii")) {
      output.push({ kind: "ascii", source: node.value ?? "" });
      continue;
    }
    if (node.type === "code" && (node.lang === "chardesk-anim" || node.lang === "ascii-anim")) {
      const frames = splitAsciiAnimationFrames(node.value ?? "");
      const sizes = frames.map(demoFrameSize);
      output.push({ kind: "animation", frames, interval: 180,
        rows: Math.max(1, ...sizes.map((size: { rows: number; width: number }) => size.rows)),
        width: Math.max(1, ...sizes.map((size: { rows: number; width: number }) => size.width)) });
      continue;
    }
    if (node.type === "math") {
      output.push({ kind: "math", source: node.value ?? "" });
      continue;
    }
    if (node.type === "paragraph" && node.children?.length === 1 && node.children[0]?.type === "inlineMath") {
      const markup = raw(node, source, sourceLabel).trim();
      if (markup.startsWith("$$") && markup.endsWith("$$")) {
        output.push({ kind: "math", source: node.children[0].value ?? "" });
        continue;
      }
    }
    if (node.type === "html") {
      const element = htmlElement(node.value ?? "");
      const name = element && htmlAttribute(element, "dataAsciiDemo");
      const asset = element && htmlAttribute(element, "dataAsciiDemoSrc");
      if (element?.tagName === "div" && name && asset && /^\.\/assets\/[a-zA-Z0-9.-]+\.js$/.test(asset)) {
        output.push({ kind: "demo", name, source: new URL(asset, `https://blog.invalid${postUrl}`).pathname,
          initial: "", interval: 100, rows: 1, width: 1 });
        continue;
      }
      throw new Error(`${sourceLabel}:${node.position?.start.line}: unsupported HTML block`);
    }
    if (node.type === "list") {
      output.push({ kind: "list", ordered: Boolean(node.ordered), start: node.start ?? 1,
        items: (node.children ?? []).map((item) => compileNodes(item.children ?? [], source, postUrl, sourceLabel, ids)) });
      continue;
    }
    if (node.type === "blockquote") {
      output.push({ kind: "quote", children: compileNodes(node.children ?? [], source, postUrl, sourceLabel, ids) });
      continue;
    }
    if (node.type === "heading") {
      const label = headingLabel(node).replace(/\s+/gu, " ").trim();
      output.push({ kind: "heading", source: markdownSource(node, source, sourceLabel),
        id: headingId(label, ids), level: node.depth ?? 1, label,
        inlineMath: inlineMathNodes(node).map((math) => math.value ?? "") });
      continue;
    }
    if (node.type === "paragraph" && containsImage(node)) {
      output.push(...paragraphWithImages(node, source, postUrl, sourceLabel, ids.imageSizes));
      continue;
    }
    if (node.type === "paragraph" || node.type === "thematicBreak" ||
      node.type === "table" || node.type === "code") {
      output.push({ kind: "markdown", source: markdownSource(node, source, sourceLabel),
        inlineMath: inlineMathNodes(node).map((math) => math.value ?? ""),
        wideContent: node.type === "table" || node.type === "code" });
      continue;
    }
    throw new Error(`${sourceLabel}:${node.position?.start.line}: unsupported Markdown node ${node.type}`);
  }
  return output;
}

export function compileCellDocument(source: string, postUrl: string, sourceLabel: string, imageSizes: ImageSizes = {}): CellDocumentNode[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source) as MdNode;
  return compileNodes(tree.children ?? [], source, postUrl, sourceLabel, { used: new Set(), count: 0, imageSizes });
}

const contentRoot = path.resolve(process.cwd(), "src/content/posts");

export async function prepareCellDocument(source: string, postUrl: string, postId: string): Promise<CellDocumentNode[]> {
  const nodes = compileCellDocument(source, postUrl, postId);
  const prepare = async (node: CellDocumentNode): Promise<CellDocumentNode> => {
    if (node.kind === "list") return { ...node,
      items: await Promise.all(node.items.map(async (item) => Promise.all(item.map(prepare)))) };
    if (node.kind === "quote" || node.kind === "center") return { ...node,
      children: await Promise.all(node.children.map(prepare)) };
    if (node.kind !== "demo") return node;
    const asset = path.resolve(contentRoot, path.dirname(postId), "assets", path.basename(node.source));
    if (!asset.startsWith(contentRoot + path.sep)) throw new Error(`${postId}: unsafe demo path`);
      const module = await import(/* @vite-ignore */ pathToFileURL(asset).href);
    if (typeof module.createAsciiDemo !== "function") throw new Error(`${postId}: ${node.name} does not export createAsciiDemo`);
    const demo = module.createAsciiDemo({ kind: node.name, api: cellDemoApi });
    if (!demo || typeof demo.render !== "function") throw new Error(`${postId}: invalid demo ${node.name}`);
    const initial = demoHtmlToProtocol(demo.render(0));
    const samples = [0, ...(Array.isArray(demo.sampleTimes) ? demo.sampleTimes : [])]
      .filter((time) => Number.isFinite(time) && time >= 0);
    const sizes = samples.map((time) => demoFrameSize(demoHtmlToProtocol(demo.render(time))));
    return { ...node, initial, interval: Number.isFinite(demo.interval) ? Math.max(16, demo.interval) : 100,
      rows: Math.max(1, ...sizes.map((size) => size.rows)), width: Math.max(1, ...sizes.map((size) => size.width)) };
  };
  return Promise.all(nodes.map(prepare));
}
