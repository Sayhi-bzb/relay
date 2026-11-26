import { getCollection, type CollectionEntry } from 'astro:content';
import { formatDate } from '../data/site';
import type { PostCard } from '../components/cell/model';

export type Source = CollectionEntry<'sources'>;

export async function getSources() {
  return (await getCollection('sources')).sort((a, b) => b.data.published_at.getTime() - a.data.published_at.getTime());
}

export function sourceUrl(source: Source) {
  return `/sources/${source.slug}/`;
}

export function sourceCard(source: Source): PostCard {
  return { title: source.data.title, date: formatDate(source.data.published_at), href: sourceUrl(source), kind: 'source' };
}

export function getProducts(sources: Source[]) {
  const products = new Map<string, { name: string; slug: string; posts: PostCard[] }>();
  for (const source of sources) {
    const product = source.data.product;
    if (!product) continue;
    const entry = products.get(product.slug) ?? { ...product, posts: [] };
    entry.posts.push(sourceCard(source));
    products.set(product.slug, entry);
  }
  return [...products.values()].sort((a, b) => a.name.localeCompare(b.name));
}
