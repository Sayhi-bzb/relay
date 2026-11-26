import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { activeSubscriptions, isAllowedContent, isStableVersion, metadataFromPayload } from '../src/content-policy.js';
import { GithubRepositorySource } from '../src/connectors/codex.js';
import type { ItemKind, Subscription } from '../src/types.js';

const subscription = (key: string, kinds: ItemKind[]): Subscription => ({
  id: key, key, name: key, enabled: true, connectorType: 'github',
  publisher: { id: 'org', key: 'org' }, product: { id: key, key }, publisherKey: 'org', productKey: key,
  streams: kinds.map((kind) => ({ id: `${key}-${kind}`, key: `${key}-${kind}`, name: kind,
    kind, enabled: true, maxItems: 20 })),
});

describe('version-update content policy', () => {
  it('keeps releases and official changelogs while excluding PR, news, blog and disabled streams', () => {
    const github = subscription('codex', ['release', 'pull_request', 'issue']);
    github.streams[0]!.prereleases = true;
    const feed = subscription('claude', ['changelog']);
    const disabled = subscription('disabled', ['release']);
    disabled.streams[0]!.enabled = false;
    const result = activeSubscriptions([github, feed, subscription('news', ['news']), subscription('blog', ['blog']), disabled]);
    expect(result.map((item) => [item.key, item.streams.map((stream) => stream.kind)]))
      .toEqual([['codex', ['release']], ['claude', ['changelog']]]);
    expect(github.streams).toHaveLength(3);
    expect(result[0]!.streams[0]!.prereleases).toBe(false);
    expect(github.streams[0]!.prereleases).toBe(true);
  });

  const stages = JSON.parse(readFileSync(new URL('./fixtures/version-stages.json', import.meta.url), 'utf8')) as Array<{
    name: string; title: string; url?: string; metadata?: Record<string, unknown>; stable: boolean;
  }>;

  it.each(stages)('classifies $name consistently', (value) => {
    expect(isStableVersion(value)).toBe(value.stable);
    expect(isAllowedContent({ ...value, kind: 'release' })).toBe(value.stable);
    expect(isAllowedContent({ ...value, kind: 'changelog' })).toBe(value.stable);
  });

  it('recognizes provider flags in legacy payload metadata before retrying sync', () => {
    const metadata = metadataFromPayload(JSON.stringify({ '元数据': JSON.stringify({ prerelease: true }) }));
    expect(isAllowedContent({ title: 'v1.2.3', kind: 'release', metadata })).toBe(false);
    expect(metadataFromPayload('malformed')).toEqual({});
  });

  it('filters prereleases and drafts at the GitHub adapter before persistence', async () => {
    const release = (id: number, name: string, prerelease = false, draft = false) => ({
      id, name, tag_name: name, prerelease, draft, published_at: '2026-11-14T00:00:00Z',
      html_url: `https://github.com/org/repo/releases/tag/${name}`, body: 'Release notes mention beta support.',
    });
    const listReleases = vi.fn().mockResolvedValue({ data: [release(1, 'v1.2.3'), release(2, 'v1.2.4-alpha', true),
      release(3, 'v1.2.4-beta'), release(4, 'v1.2.4', false, true)] });
    const source = new GithubRepositorySource({ id: 'example', name: 'Example', repository: 'org/repo',
      releases: true, prereleases: false, max_releases: 30, merged_prs: false, max_merged_prs: 0,
      issues: false, max_issues: 0 }, undefined, { rest: { repos: { listReleases } } } as never);
    const items = await source.collect({ since: new Date('2026-11-13T00:00:00Z'), now: new Date('2026-11-14T12:00:00Z') });
    expect(items.map((item) => item.externalId)).toEqual(['1']);
  });
});
