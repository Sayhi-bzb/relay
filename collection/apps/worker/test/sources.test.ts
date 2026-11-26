import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import { sourceFor } from '../src/sources.js';
import type { ItemKind, Stream, Subscription } from '../src/types.js';
import { canonicalReleaseUrl } from '../src/connectors/pi.js';

const env = { FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FEISHU_BASE_TOKEN: 'test', FEISHU_TABLE_IDS: {}, LANGFLOW_TIMEOUT_MS: 60_000 } as WorkerConfig;

function stream(kind: ItemKind, id = 1): Stream {
  return {
    enabled: true,
    id,
    key: `stream-${id}`,
    kind,
    maxItems: 25,
    name: kind,
  };
}

function feed(streams: Stream[]): Subscription {
  return {
    connectorType: 'feed',
    enabled: true,
    feedConfig: { mode: 'rss', sourceAddress: 'https://example.test/feed.xml' },
    id: 1,
    key: 'example',
    name: 'Example',
    publisher: { id: 'example', key: 'example', name: 'Example' },
    product: { id: 'example', key: 'example', name: 'Example' },
    publisherKey: 'example', productKey: 'example',
    streams,
  };
}

describe('feed stream content types', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('projects collected articles onto the configured stream kind', async () => {
    const xml = '<rss version="2.0"><channel><item><guid>1</guid><title>Launch</title><link>https://example.test/launch</link><pubDate>Sat, 05 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })));

    const items = await sourceFor(feed([stream('news')]), env).collect({
      now: new Date('2026-09-05T13:00:00Z'),
      since: new Date('2026-09-05T00:00:00Z'),
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('news');
  });

  it('projects an Atom changelog onto the changelog stream', async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Claude Code Changelog</title><entry><id>v2.1.263</id><title>Claude Code v2.1.263</title>
      <link href="https://github.com/anthropics/claude-code/releases/tag/v2.1.263"/><updated>2026-09-05T12:00:00Z</updated></entry></feed>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })));

    const items = await sourceFor(feed([stream('changelog')]), env).collect({
      now: new Date('2026-09-05T13:00:00Z'),
      since: new Date('2026-09-05T00:00:00Z'),
    });

    expect(items).toMatchObject([{ kind: 'changelog', title: 'Claude Code v2.1.263' }]);
  });

  it('limits a sitemap changelog subscription to the configured path', async () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://cursor.com/changelog/2-4</loc><lastmod>2026-09-05</lastmod></url>
      <url><loc>https://cursor.com/blog/other</loc><lastmod>2026-09-05</lastmod></url>
    </urlset>`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.endsWith('sitemap.xml') ? sitemap : '<html><head><title>Cursor 2.4</title></head><body>Release</body></html>', { status: 200 });
    }));
    const subscription: Subscription = {
      ...feed([stream('changelog')]),
      feedConfig: {
        mode: 'sitemap',
        sourceAddress: 'https://cursor.com/sitemap.xml',
        pathPrefixes: ['/changelog/'],
      },
    };

    const items = await sourceFor(subscription, env).collect({
      now: new Date('2026-09-05T13:00:00Z'),
      since: new Date('2026-09-05T00:00:00Z'),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: 'https://cursor.com/changelog/2-4', kind: 'changelog' });
  });

  it('splits the Kimi What\'s New page into dated changelog entries', async () => {
    const html = `<main><div class="vp-doc"><h1>What's New</h1>
      <h2 id="v0-41-0-september-4-2026">v0.41.0 September 4, 2026</h2><h3>Web</h3><p>Tower mode.</p>
      <h2 id="v0-40-0-september-2-2026">v0.40.0 September 2, 2026</h2><p>Older update.</p>
    </div></main>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })));
    const subscription: Subscription = {
      ...feed([stream('changelog')]),
      key: 'kimi-code-whats-new',
      name: "Kimi Code What's New",
      feedConfig: { mode: 'listing', sourceAddress: 'https://www.kimi.com/code/docs/en/kimi-code/whats-new.html' },
    };

    const items = await sourceFor(subscription, env).collect({
      now: new Date('2026-09-05T00:00:00Z'),
      since: new Date('2026-09-03T00:00:00Z'),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: 'https://www.kimi.com/code/docs/en/kimi-code/whats-new.html#v0-41-0-september-4-2026',
      kind: 'changelog',
      title: 'v0.41.0 September 4, 2026',
    });
    expect(items[0]?.content).toContain('Tower mode.');
  });

  it('uses the linked GitHub release as the canonical Pi News event ID', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><item><guid>https://pi.dev/news/releases/0.85.1</guid><title>Pi 0.85.1</title>
      <link>https://pi.dev/news/releases/0.85.1</link><pubDate>Sat, 05 Sep 2026 00:00:00 GMT</pubDate>
      <content:encoded><![CDATA[View <a href="https://github.com/earendil-works/pi/releases/tag/v0.85.1">release</a>.]]></content:encoded>
      </item></channel></rss>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })));
    const subscription: Subscription = {
      ...feed([stream('news')]), key: 'pi-news', name: 'Pi News',
      feedConfig: { mode: 'rss', sourceAddress: 'https://pi.dev/news.xml' },
    };

    const items = await sourceFor(subscription, env).collect({
      now: new Date('2026-09-06T00:00:00Z'), since: new Date('2026-09-04T00:00:00Z'),
    });

    expect(items[0]).toMatchObject({
      externalId: 'https://github.com/earendil-works/pi/releases/tag/v0.85.1',
      kind: 'news',
      metadata: { dedupePriority: 10 },
    });
    expect(canonicalReleaseUrl('none')).toBeUndefined();
  });

  it('filters sitemap entries by the extracted article date when lastmod is absent', async () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://antigravity.google/blog/new-post</loc></url>
      <url><loc>https://antigravity.google/blog/old-post</loc></url>
    </urlset>`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('sitemap.xml')) return new Response(sitemap, { status: 200 });
      const date = url.endsWith('new-post') ? '2026-09-04' : '2026-08-01';
      return new Response(`<html><head><title>Post</title></head><body><time datetime="${date}"></time><article>Body</article></body></html>`, { status: 200 });
    }));
    const subscription: Subscription = {
      ...feed([stream('blog')]),
      feedConfig: { mode: 'sitemap', sourceAddress: 'https://www.antigravity.google/sitemap.xml', pathPrefixes: ['/blog/'] },
    };

    const items = await sourceFor(subscription, env).collect({
      now: new Date('2026-09-05T00:00:00Z'), since: new Date('2026-09-01T00:00:00Z'),
    });

    expect(items.map(({ url }) => url)).toEqual(['https://antigravity.google/blog/new-post']);
  });

  it('does not download sitemap articles whose URLs are already known', async () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://antigravity.google/blog/new-post</loc></url>
      <url><loc>https://antigravity.google/blog/known-post</loc></url>
    </urlset>`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.endsWith('sitemap.xml') ? sitemap : '<html><head><title>New</title></head><body>Body</body></html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const subscription: Subscription = {
      ...feed([stream('blog')]),
      feedConfig: { mode: 'sitemap', sourceAddress: 'https://www.antigravity.google/sitemap.xml', pathPrefixes: ['/blog/'] },
    };

    const items = await sourceFor(subscription, env).collect({
      now: new Date('2026-09-05T00:00:00Z'),
      since: new Date('2026-09-01T00:00:00Z'),
      knownExternalIds: new Set(['https://antigravity.google/blog/known-post']),
    });

    expect(items.map(({ url }) => url)).toEqual(['https://antigravity.google/blog/new-post']);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('known-post'))).toBe(false);
  });

  it('rejects ambiguous feed subscriptions with multiple enabled streams', () => {
    expect(() => sourceFor(feed([stream('news'), stream('blog', 2)]), env)).toThrow(
      'feed connector requires exactly one enabled stream',
    );
  });
});
