import type { WorkerConfig } from './config.js';
import { FetchHttpClient } from './http.js';
import { subscriptionLabel } from './types.js';
import type { AppConfig, ItemKind, SourceAdapter, Subscription } from './types.js';
import { GenericFeedSource } from './connectors/feeds.js';
import { GithubRepositorySource } from './connectors/codex.js';
import { KimiWhatsNewSource } from './connectors/kimi.js';
import { PiNewsSource } from './connectors/pi.js';

export function sourceFor(subscription: Subscription, env: WorkerConfig): SourceAdapter {
  const http = new FetchHttpClient();
  const name = subscriptionLabel(subscription);
  const streams = subscription.streams.filter((stream) => stream.enabled);
  const byKind = (kind: string) => streams.find((stream) => stream.kind === kind);
  if (subscription.connectorType === 'github') {
    const repository = subscription.githubConfig?.repository;
    if (!repository) throw new Error(`${name}: GitHub repository is missing`);
    const release = byKind('release'); const pr = byKind('pull_request'); const issue = byKind('issue');
    const source = new GithubRepositorySource({
      id: subscription.key, name, repository,
      releases: Boolean(release), prereleases: release?.prereleases ?? false, max_releases: release?.maxItems ?? 30,
      merged_prs: Boolean(pr), max_merged_prs: pr?.maxItems ?? 100,
      issues: Boolean(issue), max_issues: issue?.maxItems ?? 100,
      issue_include_labels: [], issue_exclude_labels: [],
    }, env.GITHUB_TOKEN);
    return subscription.key === 'pi' ? withPiReleaseIdentity(source) : source;
  }
  const config = subscription.feedConfig;
  if (!config?.sourceAddress) throw new Error(`${name}: source address is missing`);
  if (streams.length !== 1) throw new Error(`${name}: feed connector requires exactly one enabled stream`);
  const stream = streams[0]!;
  const asFeedKind = (source: SourceAdapter) => withItemKind(source, stream.kind);
  if (subscription.key === 'pi-news' && config.mode === 'rss') return asFeedKind(new PiNewsSource({
    id: subscription.key, name, rssUrl: config.sourceAddress, maxItems: stream.maxItems,
  }, http));
  if (subscription.key === 'kimi-code-whats-new' && config.mode === 'listing') return asFeedKind(new KimiWhatsNewSource({
    id: subscription.key, name, pageUrl: config.sourceAddress, maxItems: stream.maxItems,
  }, http));
  if (config.mode === 'rss') return asFeedKind(new GenericFeedSource({
    id: subscription.key, name, type: 'rss', rss_url: config.sourceAddress, max_items: stream.maxItems,
  }, http));
  if (config.mode === 'sitemap') return asFeedKind(new GenericFeedSource({
    id: subscription.key, name, type: 'sitemap', sitemap_url: config.sourceAddress,
    path_prefixes: config.pathPrefixes ?? ['/'], max_items: stream.maxItems,
  }, http));
  throw new Error(`${name}: unsupported feed mode ${config.mode}`);
}

function withPiReleaseIdentity(source: SourceAdapter): SourceAdapter {
  return {
    source: source.source, check: () => source.check(),
    collect: async (context) => (await source.collect(context)).map((item) => item.kind === 'release' ? {
      ...item, externalId: item.url, metadata: { ...item.metadata, dedupePriority: 0 },
    } : item),
  };
}
function withItemKind(source: SourceAdapter, kind: ItemKind): SourceAdapter {
  return { source: source.source, check: () => source.check(),
    collect: async (context) => (await source.collect(context)).map((item) => ({ ...item, kind })) };
}
export type ConnectorConfig = AppConfig;
