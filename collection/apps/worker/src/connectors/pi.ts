import Parser from "rss-parser";
import type { HttpClient } from "../http.js";
import type { CollectContext, SourceAdapter, SourceItem } from "../types.js";

const releaseUrlPattern = /https:\/\/github\.com\/earendil-works\/pi\/releases\/tag\/[^\s"'<>]+/i;

export class PiNewsSource implements SourceAdapter {
  readonly source: string;
  private readonly parser = new Parser();

  constructor(
    private readonly config: { id: string; name: string; rssUrl: string; maxItems: number },
    private readonly http: HttpClient,
  ) {
    this.source = config.id;
  }

  async collect(context: CollectContext): Promise<SourceItem[]> {
    const feed = await this.read();
    return feed.items.slice(0, this.config.maxItems).flatMap((item): SourceItem[] => {
      const url = item.link?.trim();
      const publishedAt = new Date(item.isoDate ?? item.pubDate ?? context.now);
      if (!url || !item.title || Number.isNaN(publishedAt.getTime()) || publishedAt < context.since) return [];
      const encodedContent = (item as unknown as Record<string, unknown>)["content:encoded"];
      const encodedSnippet = (item as unknown as Record<string, unknown>)["content:encodedSnippet"];
      const releaseUrl = canonicalReleaseUrl(typeof encodedContent === "string" ? encodedContent : item.content ?? "");
      const content = typeof encodedSnippet === "string" ? encodedSnippet : item.contentSnippet;
      return [{
        source: this.source,
        kind: "news",
        externalId: releaseUrl ?? item.guid ?? url,
        title: item.title.trim(),
        url,
        publishedAt,
        ...(content ? { content: content.trim().slice(0, 8_000) } : {}),
        metadata: {
          publisher: this.config.name,
          categories: item.categories ?? [],
          ...(releaseUrl ? { canonicalReleaseUrl: releaseUrl, dedupePriority: 10 } : {}),
        },
      }];
    });
  }

  async check(): Promise<void> {
    await this.read();
  }

  private async read() {
    return this.parser.parseString(await this.http.getText(this.config.rssUrl, { Accept: "application/rss+xml, application/xml" }));
  }
}

export function canonicalReleaseUrl(content: string): string | undefined {
  const match = content.match(releaseUrlPattern)?.[0];
  return match ? match.replace(/&amp;.*$/, "").replace(/[),.;]+$/, "") : undefined;
}
