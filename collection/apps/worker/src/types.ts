export const CONTENT_KINDS = [
  'article', 'news', 'blog', 'research', 'paper', 'documentation', 'changelog',
  'release', 'pull_request', 'issue', 'discussion', 'hn_story', 'video', 'podcast',
] as const;
export type ItemKind = (typeof CONTENT_KINDS)[number];
export type PayloadID = string | number;

export interface SourceItem {
  source: string;
  streamId?: string;
  kind: ItemKind;
  externalId: string;
  title: string;
  url: string;
  publishedAt: Date;
  content?: string;
  metadata: Record<string, unknown>;
}

export interface CollectContext { now: Date; since: Date; knownExternalIds?: ReadonlySet<string> }
export interface SourceAdapter { source: string; collect(context: CollectContext): Promise<SourceItem[]>; check(): Promise<void> }

export interface Stream {
  id: PayloadID;
  key: string;
  name: string;
  kind: ItemKind;
  enabled: boolean;
  maxItems: number;
  prereleases?: boolean;
  lastSuccessAt?: string | null;
  langflowDraftFlowId?: string | null;
  langflowProductionFlowId?: string | null;
}

export interface CatalogRelation {
  id: PayloadID;
  key: string;
  name?: string;
}

export interface Subscription {
  id: PayloadID;
  key: string;
  name: string;
  enabled: boolean;
  publisher: CatalogRelation;
  product: CatalogRelation;
  publisherKey: string;
  productKey: string;
  connectorType: 'feed' | 'github';
  feedConfig?: {
    mode: 'rss' | 'sitemap' | 'listing';
    sourceAddress: string;
    pathPrefixes?: string[];
  };
  githubConfig?: { repository: string };
  streams: Stream[];
}

export function subscriptionProductLabel(subscription: Subscription): string {
  return [subscription.publisher.name, subscription.product.name].filter(Boolean).join(' / ') || subscription.key;
}

export function subscriptionLabel(subscription: Subscription): string {
  return `${subscriptionProductLabel(subscription)} · ${subscription.name}`;
}

export interface AppConfig {
  env: { GITHUB_TOKEN?: string; LLM_API_KEY?: string; LLM_BASE_URL?: string; LLM_MODEL?: string };
  sources: {
    feeds: Array<
      | { id: string; name: string; type: 'rss'; rss_url: string; max_items: number }
      | { id: string; name: string; type: 'sitemap'; sitemap_url: string; path_prefixes: string[]; max_items: number }
    >;
    github: { repositories: Array<{ id: string; name: string; repository: string; releases: boolean; prereleases: boolean; max_releases: number; merged_prs: boolean; max_merged_prs: number; issues: boolean; max_issues: number; issue_include_labels: string[]; issue_exclude_labels: string[] }> };
  };
}
