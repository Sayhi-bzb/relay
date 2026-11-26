import { styleCodes } from "./cell-demo.js";

export function demoHtmlToProtocol(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html);
  const project = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return [...node.childNodes].map(project).join("");
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName.toLowerCase() !== "span") {
      throw new Error(`Unsupported demo HTML: ${node.nodeName}`);
    }
    const content = [...node.childNodes].map(project).join("");
    const codes = styleCodes(node.getAttribute("style") ?? "");
    return codes.length ? `[${codes.join(";")}m${content}[0m` : content;
  };
  return project(template.content);
}
