import { JSDOM } from "jsdom";
import type { HttpClient } from "../http.js";
import type { CollectContext, SourceAdapter, SourceItem } from "../types.js";

const datePattern = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;

export class KimiWhatsNewSource implements SourceAdapter {
  readonly source: string;

  constructor(
    private readonly config: { id: string; name: string; pageUrl: string; maxItems: number },
    private readonly http: HttpClient,
  ) {
    this.source = config.id;
  }

  async collect(context: CollectContext): Promise<SourceItem[]> {
    const entries = this.parse(await this.http.getText(this.config.pageUrl, { Accept: "text/html" }));
    return entries
      .filter((entry) => entry.publishedAt >= context.since)
      .slice(0, this.config.maxItems);
  }

  async check(): Promise<void> {
    const entries = this.parse(await this.http.getText(this.config.pageUrl, { Accept: "text/html" }));
    if (entries.length === 0) throw new Error(`${this.config.name} page contains no dated changelog sections`);
  }

  private parse(html: string): SourceItem[] {
    const document = new JSDOM(html, { url: this.config.pageUrl }).window.document;
    const root = document.querySelector("main .vp-doc, .vp-doc, main, article");
    if (!root) return [];

    return [...root.querySelectorAll<HTMLHeadingElement>("h2[id]")].flatMap((heading): SourceItem[] => {
      const title = cleanText(heading.textContent);
      const dateText = title.match(datePattern)?.[0];
      if (!dateText || !heading.id) return [];
      const publishedAt = new Date(`${dateText} 00:00:00 UTC`);
      if (Number.isNaN(publishedAt.getTime())) return [];

      const sections: string[] = [];
      let sibling = heading.nextElementSibling;
      while (sibling && sibling.tagName !== "H2") {
        const content = cleanText(sibling.textContent);
        if (content) sections.push(content);
        sibling = sibling.nextElementSibling;
      }
      const url = new URL(`#${heading.id}`, this.config.pageUrl).toString();
      return [{
        source: this.source,
        kind: "changelog",
        externalId: url,
        title,
        url,
        publishedAt,
        ...(sections.length ? { content: sections.join("\n").slice(0, 8_000) } : {}),
        metadata: { publisher: this.config.name, sectionId: heading.id },
      }];
    });
  }
}

function cleanText(value: string | null): string {
  return (value ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").replace(/\s*#\s*$/, "").trim();
}
