import rss from '@astrojs/rss';
import { site } from '../data/site';
import { getSources, sourceUrl } from '../lib/sources';

export async function GET(context) {
  return rss({
    title: site.title,
    description: site.description,
    site: context.site,
    items: (await getSources()).map(source => ({
      title: source.data.title,
      description: source.data.description,
      pubDate: source.data.published_at,
      link: sourceUrl(source),
    })),
  });
}
