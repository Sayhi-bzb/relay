import { createHash } from 'node:crypto';
import type { WorkerConfig } from './config.js';
import { AiEditor } from './ai.js';
import { NewsProcessor } from './langflow.js';
import { BaseClient } from './base.js';
import { sourceFor } from './sources.js';
import { SourceCatalog } from './sqlite.js';
import { exportObsidian } from './obsidian.js';
import { activeSubscriptions, allowedContentKinds, includePrereleases, isAllowedContent, metadataFromPayload } from './content-policy.js';
import { subscriptionProductLabel } from './types.js';
import type { PayloadID, SourceItem, Stream, Subscription } from './types.js';

type Settings = { timezone: string; digestHour: number; sourceOverlapMinutes: number; cutoverAt?: string | null };
type NewsRecord = SourceItem & { id: PayloadID; rawContent?: string; publishedAtSource: string; subscription?: Subscription };
type ExistingNews = { id: PayloadID; metadata?: Record<string, unknown> | null };
type StoredNews = { id: PayloadID; externalId: string; kind: SourceItem['kind']; title: string; url: string;
  rawContent?: string | null; metadata?: Record<string, unknown> | null; publishedAtSource: string;
  subscription?: Subscription; stream?: Stream };
const defaults: Settings = { timezone: 'Asia/Shanghai', digestHour: 8, sourceOverlapMinutes: 10 };

export function newsDedupeKey(subscriptionKey: string, externalId: string) {
  return createHash('sha256').update(`${subscriptionKey}:${externalId}`).digest('hex');
}

export class WorkerRuntime {
  private readonly base: BaseClient;
  private readonly ai: AiEditor;
  private readonly newsProcessor: NewsProcessor;
  constructor(private readonly config: WorkerConfig) {
    this.base = new BaseClient(config);
    this.ai = new AiEditor(config);
    this.newsProcessor = new NewsProcessor(config, this.base);
  }

  async run() {
    const settings = await this.settings();
    if (!settings.cutoverAt) throw new Error('Settings.CutoverAt is required before collecting new content');
    const catalog = new SourceCatalog(this.config.SOURCE_DB_PATH);
    try {
      const subscriptions = activeSubscriptions(await this.base.subscriptions());
      const collection = await this.collect(settings, subscriptions, catalog);
      await this.syncSources(catalog, subscriptions);
      for (const streamId of collection.successfulStreams) {
        await this.base.update('subscription-streams', streamId, { lastSuccessAt: new Date().toISOString() });
      }
      if (collection.failures) throw new Error(`${collection.failures} subscription(s) failed; inspect systemd journal`);
    } finally {
      try { await this.exportVault(); } finally { catalog.close(); }
    }
  }

  private async exportVault() {
    if (this.config.OBSIDIAN_VAULT_PATH) {
      await exportObsidian(this.config.SOURCE_DB_PATH, this.config.OBSIDIAN_VAULT_PATH);
    }
  }

  async doctor() {
    const subscriptions = activeSubscriptions(await this.base.subscriptions());
    const checks = await Promise.allSettled(subscriptions.map((subscription) => sourceFor(subscription, this.config).check()));
    const failed = checks.flatMap((result, index) => result.status === 'rejected' ? [`${subscriptions[index]!.name}: ${message(result.reason)}`] : []);
    return { base: 'ok', subscriptions: subscriptions.length, healthy: subscriptions.length - failed.length,
      failed, llm: this.ai.enabled ? 'enabled' : 'disabled', langflow: this.newsProcessor.enabled ? 'enabled' : 'disabled' };
  }

  async sync() {
    const catalog = new SourceCatalog(this.config.SOURCE_DB_PATH);
    try {
      await this.syncSources(catalog, activeSubscriptions(await this.base.subscriptions()));
    } finally {
      try { await this.exportVault(); } finally { catalog.close(); }
    }
  }

  async applyContentPolicy(apply = false) {
    const streams = (await this.base.list<Stream>('subscription-streams', { limit: 2000 })).docs;
    const changes: Array<Pick<Stream, 'id' | 'key' | 'kind'> & { enabled?: false; prereleases?: false }> = [];
    for (const stream of streams) {
      const identity = { id: stream.id, key: stream.key, kind: stream.kind };
      if (stream.enabled && !allowedContentKinds.includes(stream.kind)) changes.push({ ...identity, enabled: false });
      else if (stream.kind === 'release' && stream.prereleases && !includePrereleases)
        changes.push({ ...identity, prereleases: false });
    }
    if (apply) for (const change of changes) {
      const { id, key: _key, kind: _kind, ...fields } = change;
      await this.base.update('subscription-streams', id, fields);
    }
    return { applied: apply, allowedKinds: allowedContentKinds, includePrereleases, changes };
  }

  async langflowSmoke(sequential = 3, concurrent = 2) {
    if (!this.newsProcessor.enabled) throw new Error('Langflow and LLM model configuration are required');
    const durations: number[] = [];
    const invoke = async (suffix: string) => {
      const started = performance.now();
      const result = await this.newsProcessor.smoke({
        schemaVersion: 2, newsItemId: `capacity-${suffix}`, title: 'AI Data Terminal capacity verification',
        kind: 'news', url: 'https://example.com/capacity-verification',
        rawContent: 'A production capacity verification request for the AI news processing pipeline. Return only the required JSON contract.',
        publishedAtSource: new Date().toISOString(), metadata: { synthetic: true },
        source: { publisher: null, product: null,
          subscription: { id: 'capacity', key: 'capacity', name: 'Capacity', connectorType: 'feed' },
          stream: { id: 'capacity', key: 'capacity', name: 'Capacity', kind: 'news' } },
      });
      durations.push(Math.round(performance.now() - started));
      return result.output;
    };
    await invoke('warmup');
    for (let index = 0; index < sequential; index++) await invoke(`sequential-${index + 1}`);
    await Promise.all(Array.from({ length: concurrent }, (_, index) => invoke(`concurrent-${index + 1}`)));
    return { ok: true, calls: durations.length, durationsMs: durations,
      maxDurationMs: Math.max(...durations), meanDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) };
  }

  async reprocessLatest(streamKey?: string) {
    if (!this.newsProcessor.enabled) throw new Error('Langflow and LLM model configuration are required');
    const latest = (await this.base.list<StoredNews>('news-items', { depth: 2, limit: 2000, sort: '-publishedAtSource',
      where: { kind: { in: allowedContentKinds }, ...(streamKey ? { 'stream.key': { equals: streamKey } } : {}) } })).docs.find(isAllowedContent);
    if (!latest) throw new Error('No news item is available for reprocessing');
    if (!allowedContentKinds.includes(latest.kind)) throw new Error('This source kind is outside the active content policy');
    if (!latest.subscription || !latest.stream) throw new Error(`News item ${latest.id} has no subscription or stream`);
    const item: SourceItem = { source: 'base', externalId: latest.externalId, kind: latest.kind, title: latest.title,
      url: latest.url, content: latest.rawContent ?? undefined, publishedAt: new Date(latest.publishedAtSource),
      metadata: latest.metadata ?? {} };
    if (!await this.newsProcessor.process(latest.id, item, latest.subscription, latest.stream))
      throw new Error(`Langflow failed to reprocess news item ${latest.id}`);
    return { ok: true, newsItemId: latest.id };
  }

  private async settings(): Promise<Settings> {
    return { ...defaults, ...(await this.base.getGlobal<Settings>('system-settings')) };
  }

  private async collect(settings: Settings, subscriptions: Subscription[], catalog: SourceCatalog) {
    let failures = 0;
    const successfulStreams: string[] = [];
    for (const subscription of subscriptions) {
      const streams = subscription.streams.filter((stream) => stream.enabled);
      if (!streams.length) continue;
      const cutover = Date.parse(settings.cutoverAt!);
      const oldestSuccess = streams.flatMap((stream) => stream.lastSuccessAt ? [Date.parse(stream.lastSuccessAt)] : []);
      const since = new Date(Math.max(cutover, oldestSuccess.length
        ? Math.min(...oldestSuccess) - settings.sourceOverlapMinutes * 60_000 : cutover));
      try {
        const knownExternalIds = subscription.connectorType === 'feed' && subscription.feedConfig?.mode === 'sitemap'
          ? catalog.knownExternalIds(subscription.key) : undefined;
        const items = await sourceFor(subscription, this.config).collect({ now: new Date(), since, knownExternalIds });
        for (const stream of streams) {
          const selected = items.filter((item) => isAllowedContent(item) && item.kind === stream.kind && item.publishedAt.getTime() >= cutover)
            .slice(0, stream.maxItems);
          let inserted = 0;
          for (const item of selected) if (this.insertNews(catalog, subscription, stream, item)) inserted++;
          successfulStreams.push(String(stream.id));
          console.log(JSON.stringify({ stream: stream.key, fetched: selected.length, inserted }));
        }
      } catch (error) {
        failures++;
        console.error(JSON.stringify({ subscription: subscription.key, error: message(error) }));
      }
    }
    return { failures, successfulStreams };
  }

  private insertNews(catalog: SourceCatalog, subscription: Subscription, stream: Stream, item: SourceItem): boolean {
    return catalog.upsert(subscription, stream, item).inserted;
  }

  private async syncSources(catalog: SourceCatalog, subscriptions: Subscription[]) {
    const pending = catalog.pending(2000, allowedContentKinds).filter((row) => isAllowedContent({
      kind: row.sourceType, title: row.title, url: row.url, metadata: metadataFromPayload(row.rawPayload),
    }));
    if (!pending.length) return;
    const runId = catalog.startSyncRun();
    let created = 0;
    let updated = 0;
    let failed = 0;
    try {
      const existing = await this.base.list<StoredNews>('news-items', { depth: 2, limit: 2000 });
      const byKey = new Map(existing.docs
        .filter((item) => item.subscription && item.externalId)
        .map((item) => [`${item.subscription!.key}:${item.externalId}`, item]));
      for (const row of pending) {
        let stage = 'payload';
        try {
          const item = catalog.payload(row);
          const subscription = subscriptions.find((value) => value.key === row.subscriptionKey)
            ?? existing.docs.find((value) => value.id === row.feishuRecordId)?.subscription;
          if (!subscription) throw new Error(`Subscription ${row.subscriptionKey ?? '(missing)'} is unavailable`);
          const existingNews = byKey.get(`${subscription.key}:${row.externalId}`);
          const stream = subscriptions.flatMap((value) => value.streams)
            .find((value) => value.key === row.streamKey)
            ?? existingNews?.stream;
          if (!stream) throw new Error(`Stream ${row.streamKey ?? '(missing)'} is unavailable`);
          const data = { dedupeKey: newsDedupeKey(subscription.key, item.externalId), externalId: item.externalId,
            kind: item.kind, title: item.title, url: item.url, rawContent: item.content ?? null,
            metadata: item.metadata, publishedAtSource: item.publishedAt.toISOString(), subscription: subscription.id,
            subscriptionKey: subscription.key, stream: stream.id };
          stage = existingNews ? 'update' : 'create';
          const recordId = existingNews?.id ?? (await this.base.create<{ id: PayloadID }>('news-items', {
            ...data, discoveredAt: new Date().toISOString() })).id;
          if (existingNews) {
            await this.base.update('news-items', recordId, data);
            updated++;
          } else {
            created++;
          }
          stage = 'archive';
          catalog.markArchived(row.id, String(recordId));
          byKey.set(`${subscription.key}:${row.externalId}`, { ...item, id: recordId, subscription, stream,
            publishedAtSource: item.publishedAt.toISOString() });
        } catch (error) {
          failed++;
          catalog.markFailed(row.id, error);
          console.error(JSON.stringify({ sourceEventId: row.id, processor: 'feishu-sync', stage, error: message(error) }));
        }
      }
      catalog.finishSyncRun(runId, failed ? 'failed' : 'success', created, updated, failed);
      console.log(JSON.stringify({ sync: { created, updated, failed } }));
    } catch (error) {
      catalog.finishSyncRun(runId, 'failed', created, updated, pending.length, error);
      throw error;
    }
  }

  private async generateDigestIfDue(settings: Settings) {
    if (localHour(new Date(), settings.timezone) < settings.digestHour) return;
    const date = localDate(new Date(), settings.timezone);
    if ((await this.base.list('digests', { where: { digestDate: { equals: date } }, limit: 1 })).docs.length) return;
    const range = utcRangeForLocalDate(date, settings.timezone);
    const items = (await this.base.list<NewsRecord>('news-items', { depth: 1,
      where: { publishedAtSource: { greater_than_equal: range.start, less_than: range.end },
        kind: { in: allowedContentKinds } },
      sort: '-publishedAtSource', limit: 500 })).docs.filter(isAllowedContent);
    let generated: Awaited<ReturnType<AiEditor['digest']>>;
    try { generated = await this.ai.digest(date, items.map((item) => ({ ...item, content: item.rawContent }))); }
    catch (error) { console.error(JSON.stringify({ digest: date, error: message(error) })); }
    const introduction = generated?.introduction ?? `共收录 ${items.length} 条 AI 上游动态。`;
    const markdown = generated ? `${generated.markdown}\n\n${renderOriginalLinks(items)}` : renderDigest(date, items);
    await this.base.create('digests', { digestDate: date, introduction, markdown,
      generatedAt: new Date().toISOString(), items: items.map((item) => item.id) });
  }
}

export function dedupePriority(metadata?: Record<string, unknown> | null): number {
  const value = metadata?.dedupePriority;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function renderDigest(date: string, items: NewsRecord[]) {
  const groups = new Map<string, NewsRecord[]>();
  for (const item of items) { const key = item.subscription ? subscriptionProductLabel(item.subscription) : item.source ?? '其他'; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [`# AI 情报日报 · ${date}`, '', ...[...groups].flatMap(([name, rows]) => [`## ${name}`, '', ...rows.map((item) => `- [${item.title}](${item.url}) · ${item.kind}`), ''])].join('\n');
}
function renderOriginalLinks(items: NewsRecord[]) { return ['## 全部原始链接', '', ...items.map((item) => `- [${item.title}](${item.url}) · ${item.kind}`)].join('\n'); }
function localDate(date: Date, timezone: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function localHour(date: Date, timezone: string) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(date)); }
function utcRangeForLocalDate(date: string, timezone: string) {
  const guess = new Date(`${date}T00:00:00Z`).getTime();
  const nextDate = new Date(guess + 86_400_000).toISOString().slice(0, 10);
  return { start: zonedMidnight(date, timezone).toISOString(), end: zonedMidnight(nextDate, timezone).toISOString() };
}
function zonedMidnight(date: string, timezone: string) {
  const guess = new Date(`${date}T00:00:00Z`).getTime();
  let value = guess - timezoneOffset(new Date(guess), timezone);
  value = guess - timezoneOffset(new Date(value), timezone);
  return new Date(value);
}
function timezoneOffset(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second)) - date.getTime();
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
