import { fromHtml } from "hast-util-from-html";
import { styleCodes } from "./cell-demo.js";

export function demoHtmlToProtocol(html) {
  const tree = fromHtml(String(html), { fragment: true });
  const project = (node) => {
    if (node.type === "text") return node.value;
    if (node.type === "root") return node.children.map(project).join("");
    if (node.type !== "element" || node.tagName !== "span") throw new Error(`Unsupported demo HTML: ${node.tagName ?? node.type}`);
    const content = node.children.map(project).join("");
    const codes = styleCodes(node.properties.style ?? "");
    return codes.length ? `[${codes.join(";")}m${content}[0m` : content;
  };
  return project(tree);
}
