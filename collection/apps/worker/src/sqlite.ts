import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SourceItem, Stream, Subscription } from './types.js'

type SourceEventRow = {
  id: number
  productKey: string
  productName: string
  sourceType: string
  externalId: string
  url: string
  title: string
  content: string
  rawPayload: string
  publishedAt: string | null
  updatedAtSource: string | null
  status: 'new' | 'processing' | 'archived' | 'failed'
  lastError: string | null
  subscriptionKey: string | null
  streamKey: string | null
  feishuRecordId: string | null
}

export class SourceCatalog {
  readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 10000')
    this.ensureSchema()
  }

  close() { this.db.close() }

  private ensureSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repository_url TEXT,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS source_events (
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        source_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        raw_payload TEXT NOT NULL DEFAULT '{}',
        published_at TEXT,
        updated_at_source TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (source_type, external_id)
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS source_event_tags (
        source_event_id INTEGER NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (source_event_id, tag_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT,
        status TEXT NOT NULL,
        created_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_source_events_queue ON source_events(status, published_at);
      CREATE INDEX IF NOT EXISTS idx_source_events_product ON source_events(product_id, published_at);
    `)
    for (const column of [
      ['subscription_key', 'TEXT'], ['stream_key', 'TEXT'], ['feishu_record_id', 'TEXT'],
    ]) {
      try { this.db.exec(`ALTER TABLE source_events ADD COLUMN ${column[0]} ${column[1]}`) } catch (error) {
        if (!String(error).includes('duplicate column name')) throw error
      }
    }
    this.backfillLegacyRows()
  }

  private backfillLegacyRows() {
    const rows = this.db.prepare('SELECT id, raw_payload, feishu_record_id, subscription_key FROM source_events').all() as Array<{
      id: number; raw_payload: string; feishu_record_id: string | null; subscription_key: string | null
    }>
    const update = this.db.prepare(`UPDATE source_events SET
      feishu_record_id=COALESCE(feishu_record_id, ?),
      subscription_key=COALESCE(subscription_key, ?),
      status=CASE WHEN ? IS NOT NULL AND status IN ('new','failed') THEN 'archived' ELSE status END
      WHERE id=?`)
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        let payload: Record<string, unknown> = {}
        try { payload = JSON.parse(row.raw_payload) } catch { /* leave malformed legacy payload untouched */ }
        const recordId = typeof payload.record_id === 'string' ? payload.record_id : null
        const subscriptionKey = typeof payload['订阅标识'] === 'string' ? payload['订阅标识'] : null
        update.run(recordId, subscriptionKey, recordId, row.id)
      }
    })
    transaction()
  }

  private product(product: Subscription) {
    const key = product.product.key || product.key
    this.db.prepare(`INSERT INTO products(key, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name, updated_at=CURRENT_TIMESTAMP`)
      .run(key, product.product.name || key)
    return this.db.prepare('SELECT id FROM products WHERE key=?').get(key) as { id: number }
  }

  upsert(subscription: Subscription, stream: Stream, item: SourceItem): { id: number; inserted: boolean } {
    const product = this.product(subscription)
    const payload = JSON.stringify(item, (_key, value) => value instanceof Date ? value.toISOString() : value)
    const existing = this.db.prepare('SELECT id FROM source_events WHERE source_type=? AND external_id=?')
      .get(item.kind, item.externalId) as { id: number } | undefined
    this.db.prepare(`INSERT INTO source_events(
      product_id, source_type, external_id, url, title, content, raw_payload,
      published_at, updated_at_source, status, subscription_key, stream_key, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_type, external_id) DO UPDATE SET
      product_id=excluded.product_id, url=excluded.url, title=excluded.title,
      content=excluded.content, raw_payload=excluded.raw_payload,
      published_at=excluded.published_at, updated_at_source=excluded.updated_at_source,
      subscription_key=excluded.subscription_key, stream_key=excluded.stream_key,
      updated_at=CURRENT_TIMESTAMP,
      status=CASE WHEN source_events.status='archived' THEN 'archived' ELSE 'new' END,
      last_error=NULL`)
      .run(product.id, item.kind, item.externalId, item.url, item.title, item.content ?? '', payload,
        item.publishedAt.toISOString(), null, subscription.key, stream.key)
    const row = this.db.prepare('SELECT id FROM source_events WHERE source_type=? AND external_id=?')
      .get(item.kind, item.externalId) as { id: number }
    return { id: row.id, inserted: !existing }
  }

  knownExternalIds(subscriptionKey: string): Set<string> {
    const rows = this.db.prepare('SELECT external_id FROM source_events WHERE subscription_key=?').all(subscriptionKey) as Array<{ external_id: string }>
    return new Set(rows.map((row) => row.external_id))
  }

  pending(limit = 2000, kinds?: string[]): SourceEventRow[] {
    if (kinds && kinds.length === 0) return [];
    return this.db.prepare(`SELECT e.id, p.key AS productKey, p.name AS productName,
      e.source_type AS sourceType, e.external_id AS externalId, e.url, e.title, e.content,
      e.raw_payload AS rawPayload, e.published_at AS publishedAt, e.updated_at_source AS updatedAtSource,
      e.status, e.last_error AS lastError, e.subscription_key AS subscriptionKey,
      e.stream_key AS streamKey, e.feishu_record_id AS feishuRecordId
      FROM source_events e JOIN products p ON p.id=e.product_id
      WHERE e.status IN ('new','failed')
      ${kinds ? `AND e.source_type IN (${kinds.map(() => '?').join(',')})` : ''}
      ORDER BY e.published_at LIMIT ?`).all(...(kinds ?? []), limit) as SourceEventRow[]
  }

  payload(row: SourceEventRow): SourceItem {
    const value = JSON.parse(row.rawPayload) as SourceItem & { publishedAt: string }
    return { ...value, publishedAt: new Date(value.publishedAt) }
  }

  markArchived(id: number, feishuRecordId: string) {
    this.db.prepare(`UPDATE source_events SET status='archived', feishu_record_id=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(feishuRecordId, id)
  }

  markFailed(id: number, error: unknown) {
    this.db.prepare(`UPDATE source_events SET status='failed', last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(String(error).slice(0, 2000), id)
  }

  startSyncRun() {
    const result = this.db.prepare("INSERT INTO sync_runs(status) VALUES ('running')").run()
    return Number(result.lastInsertRowid)
  }

  finishSyncRun(id: number, status: 'success' | 'failed', created = 0, updated = 0, failed = 0, error?: unknown) {
    this.db.prepare(`UPDATE sync_runs SET finished_at=CURRENT_TIMESTAMP, status=?, created_count=?,
      updated_count=?, failed_count=?, error_message=? WHERE id=?`)
      .run(status, created, updated, failed, error ? String(error).slice(0, 2000) : null, id)
  }
}
