import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export function parseSitemap(xml: string): { urls: SitemapUrl[]; sitemaps: SitemapUrl[] } {
  const parsed = parser.parse(xml) as {
    urlset?: { url?: Array<{ loc?: string; lastmod?: string }> | { loc?: string; lastmod?: string } };
    sitemapindex?: { sitemap?: Array<{ loc?: string; lastmod?: string }> | { loc?: string; lastmod?: string } };
  };
  const mapEntry = (entry: { loc?: string; lastmod?: string }): SitemapUrl | undefined =>
    entry.loc ? { loc: entry.loc, ...(entry.lastmod ? { lastmod: entry.lastmod } : {}) } : undefined;
  return {
    urls: asArray(parsed.urlset?.url).map(mapEntry).filter((v): v is SitemapUrl => Boolean(v)),
    sitemaps: asArray(parsed.sitemapindex?.sitemap).map(mapEntry).filter((v): v is SitemapUrl => Boolean(v)),
  };
}

export function isAfter(value: string | undefined, since: Date): boolean {
  if (!value) return true;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date >= since;
}
