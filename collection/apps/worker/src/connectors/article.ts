import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { HttpClient } from "../http.js";

export interface ExtractedArticle {
  title?: string;
  content?: string;
  publishedAt?: Date;
  publishedDatePrecision?: "day" | "instant";
}

export async function extractArticle(http: HttpClient, url: string): Promise<ExtractedArticle> {
  const html = await http.getText(url, { Accept: "text/html" });
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const publishedRaw =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ??
    document.querySelector("time[datetime]")?.getAttribute("datetime") ??
    undefined;
  const visibleDate = document.querySelector("span.date")?.textContent?.trim();
  const parsed = new Readability(document).parse();
  const publishedAt = publishedRaw ? new Date(publishedRaw) : visibleDate ? new Date(`${visibleDate} UTC`) : undefined;
  const validPublishedAt = publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined;
  return {
    ...(parsed?.title ? { title: parsed.title.trim() } : {}),
    ...(parsed?.textContent ? { content: parsed.textContent.replace(/\s+/g, " ").trim().slice(0, 8_000) } : {}),
    ...(validPublishedAt ? { publishedAt: validPublishedAt } : {}),
    ...(validPublishedAt ? { publishedDatePrecision: !publishedRaw || /^\d{4}-\d{2}-\d{2}$/.test(publishedRaw.trim()) ? "day" as const : "instant" as const } : {}),
  };
}
