import { describe, expect, it } from 'vitest'
import { extractArticle } from '../src/connectors/article.js'
import { GenericFeedSource } from '../src/connectors/feeds.js'
import type { HttpClient } from '../src/http.js'

function http(pages: Record<string, string>): HttpClient {
  return { getText: async (url) => pages[url] ?? '', getJson: async () => { throw new Error('unused') } }
}
const sitemap = 'https://antigravity.google/sitemap.xml'
const article = 'https://antigravity.google/blog/example'
const context = { now: new Date('2026-09-28T05:00:00Z'), since: new Date('2026-09-28T04:25:00Z') }
function source(html: string) {
  return new GenericFeedSource({ id: 'antigravity-blog', name: 'Antigravity', type: 'sitemap',
    sitemap_url: sitemap, path_prefixes: ['/blog/'], max_items: 1 }, http({
    [sitemap]: `<urlset><url><loc>${article}</loc></url></urlset>`, [article]: html,
  }))
}

describe('dated sitemap ingestion', () => {
  it('parses visible publication dates', async () => {
    const result = await extractArticle(http({ [article]: '<html><body><h1>Example</h1><span class="date">Aug 20, 2026</span></body></html>' }), article)
    expect(result.publishedAt?.toISOString()).toBe('2026-08-20T00:00:00.000Z')
    expect(result.publishedDatePrecision).toBe('day')
  })
  it('does not treat dated historical articles as new', async () => {
    expect(await source('<html><body><h1>Old</h1><span class="date">Aug 20, 2026</span></body></html>').collect(context)).toEqual([])
  })
  it('keeps date-only posts published earlier on the collection day', async () => {
    expect(await source('<html><body><h1>Today</h1><span class="date">Sep 28, 2026</span></body></html>').collect(context))
      .toMatchObject([{ publishedAt: context.now, metadata: { sourcePublishedDate: '2026-09-28' } }])
  })
})
