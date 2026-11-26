import { readFileSync } from 'node:fs';
import type { ItemKind, Subscription } from './types.js';

const policy = JSON.parse(readFileSync(new URL('../content-policy.json', import.meta.url), 'utf8')) as {
  category: string; allowedKinds: ItemKind[]; includePrereleases: boolean; prereleasePattern: string;
};
export const allowedContentKinds = policy.allowedKinds;
export const includePrereleases = policy.includePrereleases;
const prereleasePattern = new RegExp(policy.prereleasePattern, 'i');

type VersionContent = { title: string; metadata?: Record<string, unknown> | null; url?: string };

export function metadataFromPayload(raw: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(raw);
    const value = payload.metadata ?? payload['元数据'] ?? {};
    const metadata = typeof value === 'string' ? JSON.parse(value) : value;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  } catch { return {}; }
}

export function isStableVersion(item: VersionContent): boolean {
  const metadata = item.metadata ?? {};
  if (metadata.prerelease === true || metadata.draft === true) return false;
  let tag = '';
  try { tag = decodeURIComponent(new URL(item.url ?? '').pathname.split('/releases/tag/')[1] ?? ''); } catch { /* title and metadata still apply */ }
  return ![item.title, tag, metadata.tagName, metadata.tag_name, metadata.version, metadata.channel]
    .some((value) => typeof value === 'string' && prereleasePattern.test(value));
}

export function isAllowedContent(item: VersionContent & { kind: string }): boolean {
  return allowedContentKinds.includes(item.kind as ItemKind) && (includePrereleases || isStableVersion(item));
}

export function activeSubscriptions(subscriptions: Subscription[]): Subscription[] {
  return subscriptions.filter((subscription) => subscription.enabled).map((subscription) => ({
    ...subscription,
    streams: subscription.streams.filter((stream) => stream.enabled && allowedContentKinds.includes(stream.kind))
      .map((stream) => stream.kind === 'release' && !includePrereleases ? { ...stream, prereleases: false } : stream),
  })).filter((subscription) => subscription.streams.length > 0);
}
