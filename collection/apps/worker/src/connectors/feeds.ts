import Parser from "rss-parser";
import pLimit from "p-limit";
import type { AppConfig } from "../config.js";
import type { HttpClient } from "../http.js";
import type { CollectContext, SourceAdapter, SourceItem } from "../types.js";
import { extractArticle } from "./article.js";
import { isAfter, parseSitemap, type SitemapUrl } from "./sitemap.js";

type FeedConfig = AppConfig["sources"]["feeds"][number];
type RssFeedConfig = Extract<FeedConfig, { type: "rss" }>;
type SitemapFeedConfig = Extract<FeedConfig, { type: "sitemap" }>;
type FeedInput = FeedConfig extends infer T ? T extends FeedConfig ? Omit<T, "max_items"> & { max_items?: number } : never : never;

export class GenericFeedSource implements SourceAdapter {
  readonly source: string;
  private readonly parser = new Parser();
  private readonly config: FeedConfig;

  constructor(config: FeedInput, private readonly http: HttpClient) {
    this.config = { ...config, max_items: config.max_items ?? (config.type === "rss" ? 100 : 25) } as FeedConfig;
    this.source = config.id;
  }

  async collect(context: CollectContext): Promise<SourceItem[]> {
    if (this.config.type === "rss") return this.collectRss(context);
    return this.collectSitemap(context);
  }

  async check(): Promise<void> {
    if (this.config.type === "rss") {
      await this.parser.parseString(await this.http.getText(this.config.rss_url, { Accept: "application/rss+xml, application/xml" }));
      return;
    }
    const parsed = parseSitemap(await this.http.getText(this.config.sitemap_url, { Accept: "application/xml" }));
    if (parsed.urls.length === 0 && parsed.sitemaps.length === 0) throw new Error(`${this.config.name} sitemap contains no entries`);
  }

  private async collectRss(context: CollectContext, selectedConfig?: RssFeedConfig): Promise<SourceItem[]> {
    const config = selectedConfig ?? this.config as RssFeedConfig;
    const feed = await this.parser.parseString(await this.http.getText(config.rss_url, { Accept: "application/rss+xml, application/xml" }));
    return feed.items.slice(0, config.max_items).flatMap((item): SourceItem[] => {
      const url = item.link?.trim();
      const publishedAt = new Date(item.isoDate ?? item.pubDate ?? context.now);
      if (!url || !item.title || Number.isNaN(publishedAt.getTime()) || publishedAt < context.since) return [];
      return [{
        source: this.source,
        kind: "article",
        externalId: item.guid ?? url,
        title: item.title.trim(),
        url,
        publishedAt,
        ...(item.contentSnippet ? { content: item.contentSnippet.trim().slice(0, 8_000) } : {}),
        metadata: { publisher: config.name, categories: item.categories ?? [] },
      }];
    });
  }

  private async collectSitemap(context: CollectContext, selectedConfig?: SitemapFeedConfig): Promise<SourceItem[]> {
    const config = selectedConfig ?? this.config as SitemapFeedConfig;
    const root = parseSitemap(await this.http.getText(config.sitemap_url, { Accept: "application/xml" }));
    let candidates: SitemapUrl[] = root.urls;
    if (root.sitemaps.length > 0) {
      const nested = await Promise.all(root.sitemaps.slice(0, 20).map(async (entry) => parseSitemap(await this.http.getText(entry.loc)).urls));
      candidates = nested.flat();
    }
    const selected = candidates
      .filter((entry) => config.path_prefixes.some((prefix) => new URL(entry.loc).pathname.startsWith(prefix)))
      .filter((entry) => !context.knownExternalIds?.has(entry.loc))
      .filter((entry) => isAfter(entry.lastmod, context.since))
      .slice(0, config.max_items);
    const limit = pLimit(3);
    const items = await Promise.all(selected.map((entry) => limit(async (): Promise<SourceItem> => {
      let article: Awaited<ReturnType<typeof extractArticle>> = {};
      try { article = await extractArticle(this.http, entry.loc); } catch { /* Sitemap metadata is still useful. */ }
      const datedToday = article.publishedDatePrecision === 'day' && article.publishedAt &&
        article.publishedAt.toISOString().slice(0, 10) >= context.since.toISOString().slice(0, 10);
      return {
        source: this.source,
        kind: "article",
        externalId: entry.loc,
        title: article.title ?? titleFromUrl(entry.loc),
        url: entry.loc,
        publishedAt: datedToday ? context.now : article.publishedAt ?? (entry.lastmod ? new Date(entry.lastmod) : context.now),
        ...(article.content ? { content: article.content } : {}),
        metadata: { publisher: config.name, lastmod: entry.lastmod ?? null,
          ...(article.publishedDatePrecision === 'day' && article.publishedAt ? { sourcePublishedDate: article.publishedAt.toISOString().slice(0, 10) } : {}) },
      };
    })));
    return items.filter((item) => item.publishedAt >= context.since);
  }
}

function titleFromUrl(url: string): string {
  return (new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url).replace(/-/g, " ");
}
