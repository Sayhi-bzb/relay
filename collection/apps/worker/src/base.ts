import type { WorkerConfig } from './config.js'
import type { Stream, Subscription } from './types.js'

type Fields = Record<string, unknown>
type BaseRecord = { record_id: string; fields: Fields }
type Collection = 'subscriptions' | 'subscription-streams' | 'news-items' | 'digests' | 'system-settings'
type Query = { where?: Record<string, unknown>; sort?: string; limit?: number; depth?: number; select?: Record<string, boolean> }
type Paginated<T> = { docs: T[]; totalDocs: number; limit: number }

const TABLE: Record<Collection, string> = {
  subscriptions: 'Subscriptions', 'subscription-streams': 'Streams', 'news-items': 'News',
  digests: 'Digests', 'system-settings': 'Settings',
}
const FIELD: Record<Collection, Record<string, string>> = {
  subscriptions: { name: '来源类型', key: '标识', enabled: '启用', publisherName: '机构', publisherKey: '机构标识',
    productName: '产品', productKey: '产品标识', connectorType: '接入类型', feedMode: '抓取方式',
    sourceAddress: '来源地址', pathPrefixes: '路径范围' },
  'subscription-streams': { name: '名称', key: '标识', subscriptionIds: '订阅', enabled: '启用',
    kind: '内容类型', maxItems: '每轮上限', prereleases: '包含预发布', lastSuccessAt: '上次成功',
    langflowDraftFlowId: '草稿流程 ID', langflowProductionFlowId: '正式流程 ID' },
  'news-items': { title: '标题', url: '链接', publishedAtSource: '发布时间', discoveredAt: '发现时间',
    subscriptionIds: '订阅', streamIds: '栏目', kind: '内容类型', editorialSummary: '摘要',
    topics: '主题', rawContent: '原文', processedContent: '整理正文', externalId: '来源 ID',
    dedupeKey: '去重键', subscriptionKey: '订阅标识', metadata: '元数据' },
  digests: { digestDate: '日期', introduction: '导语', markdown: '正文', generatedAt: '生成时间', items: '动态' },
  'system-settings': { key: '标识', timezone: '时区', digestHour: '日报小时',
    sourceOverlapMinutes: '来源重叠分钟', cutoverAt: '切换起点' },
}
const JSON_FIELDS = new Set(['pathPrefixes', 'topics', 'metadata'])
const DATE_FIELDS = new Set(['lastSuccessAt', 'publishedAtSource', 'discoveredAt', 'generatedAt', 'cutoverAt'])
const NUMBER_FIELDS = new Set(['maxItems', 'digestHour', 'sourceOverlapMinutes'])
const SELECT_FIELDS = new Set(['connectorType', 'feedMode', 'kind'])
const LINK_FIELDS = new Set(['subscriptionIds', 'streamIds', 'items'])

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part :
    typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '').join('')
  return String(value)
}
function single(value: unknown): string {
  if (Array.isArray(value)) return value.length ? text(value[0]) : ''
  return text(value)
}
function linkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((part): string[] => {
    if (typeof part === 'string') return [part]
    if (!part || typeof part !== 'object') return []
    const object = part as { id?: unknown; record_ids?: unknown }
    if (Array.isArray(object.record_ids)) return object.record_ids.map(String)
    return typeof object.id === 'string' ? [object.id] : []
  })
}
function json(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}
function date(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const result = new Date(typeof value === 'number' ? value : text(value))
  return Number.isNaN(result.getTime()) ? null : result.toISOString()
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export class BaseClient {
  private token?: { value: string; expires: number }
  private readonly cache = new Map<Collection, BaseRecord[]>()

  constructor(private readonly config: Pick<WorkerConfig, 'FEISHU_APP_ID' | 'FEISHU_APP_SECRET' |
    'FEISHU_BASE_TOKEN' | 'FEISHU_TABLE_IDS'>) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.FEISHU_APP_ID, app_secret: this.config.FEISHU_APP_SECRET }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json() as { code?: number; tenant_access_token?: string; expire?: number }
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw new Error('Feishu token request failed')
    this.token = { value: body.tenant_access_token, expires: Date.now() + (body.expire ?? 7200) * 1000 }
    return this.token.value
  }

  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
        method, headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
      const envelope = await response.json() as { code: number; msg?: string; data?: T }
      if (response.ok && envelope.code === 0 && envelope.data !== undefined) return envelope.data
      if (response.status === 401 && attempt === 0) { this.token = undefined; continue }
      if ((response.status === 429 || response.status >= 500 || envelope.code === 1254290) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
        continue
      }
      throw new Error(`Feishu Base ${method} ${path}: ${envelope.code} ${envelope.msg ?? response.status}`)
    }
    throw new Error('Feishu Base retry limit reached')
  }

  private path(collection: Collection): string {
    const id = this.config.FEISHU_TABLE_IDS[TABLE[collection]]
    if (!id) throw new Error(`Missing Feishu table ID: ${TABLE[collection]}`)
    return `/bitable/v1/apps/${this.config.FEISHU_BASE_TOKEN}/tables/${id}/records`
  }

  private async rows(collection: Collection): Promise<BaseRecord[]> {
    const cached = this.cache.get(collection)
    if (cached) return cached
    const all: BaseRecord[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({ page_size: '500' })
      if (pageToken) params.set('page_token', pageToken)
      const data = await this.request<{ items?: BaseRecord[]; has_more?: boolean; page_token?: string }>(
        'GET', `${this.path(collection)}?${params}`)
      all.push(...(data.items ?? []))
      pageToken = data.has_more ? data.page_token : undefined
      if (data.has_more && !pageToken) throw new Error(`Feishu pagination lost token: ${collection}`)
    } while (pageToken)
    this.cache.set(collection, all)
    return all
  }

  private decode(collection: Collection, fields: Fields): Record<string, unknown> {
    const reverse = Object.fromEntries(Object.entries(FIELD[collection]).map(([key, label]) => [label, key]))
    const result: Record<string, unknown> = {}
    for (const [label, raw] of Object.entries(fields)) {
      if (collection === 'subscriptions' && label === '名称' && !('来源类型' in fields)) {
        result.name = text(raw)
        continue
      }
      const target = reverse[label]
      if (!target) continue
      if (LINK_FIELDS.has(target)) result[target] = linkIds(raw)
      else if (JSON_FIELDS.has(target)) result[target] = json(text(raw), target === 'metadata' ? {} : [])
      else if (DATE_FIELDS.has(target)) result[target] = date(raw)
      else if (NUMBER_FIELDS.has(target)) {
        const value = Number(raw)
        result[target] = Number.isFinite(value) ? value : undefined
      }
      else if (SELECT_FIELDS.has(target)) result[target] = single(raw)
      else if (typeof raw === 'boolean' || typeof raw === 'number') result[target] = raw
      else result[target] = text(raw)
    }
    return result
  }

  private async materialize(collection: Collection, row: BaseRecord, depth = 0): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { id: row.record_id, ...this.decode(collection, row.fields) }
    if (collection === 'subscriptions') {
      result.publisher = { id: result.publisherKey, key: result.publisherKey, name: result.publisherName }
      result.product = { id: result.productKey, key: result.productKey, name: result.productName }
      result.feedConfig = result.connectorType === 'feed' ? {
        mode: result.feedMode, sourceAddress: result.sourceAddress, pathPrefixes: result.pathPrefixes ?? [],
      } : undefined
      result.githubConfig = result.connectorType === 'github' ? { repository: result.sourceAddress } : undefined
    }
    if (collection === 'news-items') {
      const subscription = (await this.rows('subscriptions')).find((item) => item.record_id === (result.subscriptionIds as string[] | undefined)?.[0])
      const stream = (await this.rows('subscription-streams')).find((item) => item.record_id === (result.streamIds as string[] | undefined)?.[0])
      result.subscription = subscription ? (depth ? await this.materialize('subscriptions', subscription, 1) : subscription.record_id) : null
      result.stream = stream ? (depth ? await this.materialize('subscription-streams', stream, 0) : stream.record_id) : null
    }
    return result
  }

  async list<T>(name: string, query: Query = {}): Promise<Paginated<T>> {
    const collection = name as Collection
    if (!(collection in TABLE)) throw new Error(`Unknown collection ${name}`)
    const records = await Promise.all((await this.rows(collection)).map((row) => this.materialize(collection, row, query.depth ?? 0)))
    const filtered = records.filter((record) => matches(record, query.where))
    if (query.sort) {
      const descending = query.sort.startsWith('-')
      const field = descending ? query.sort.slice(1) : query.sort
      filtered.sort((a, b) => compare(a[field], b[field]) * (descending ? -1 : 1))
    }
    return { docs: filtered.slice(0, query.limit ?? 2000) as T[], totalDocs: filtered.length, limit: query.limit ?? 2000 }
  }

  async getGlobal<T>(slug: string): Promise<T> {
    if (slug !== 'system-settings') throw new Error(`Unknown global ${slug}`)
    const settings = (await this.rows('system-settings')).find((row) => text(row.fields['标识']) === 'production')
    if (!settings) throw new Error('Production Settings record is missing')
    return this.decode('system-settings', settings.fields) as T
  }

  async subscriptions(): Promise<Subscription[]> {
    const streams: Record<string, unknown>[] = (await this.rows('subscription-streams')).map((row) => ({ id: row.record_id, ...this.decode('subscription-streams', row.fields) }))
    const subscriptions = await this.list<Subscription>('subscriptions', { depth: 1 })
    const keys = subscriptions.docs.map((subscription) => subscription.key)
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length)
      throw new Error('Subscription keys must be nonempty and unique for linked lookups')
    return subscriptions.docs.filter((sub) => sub.enabled).map((sub) => ({ ...sub, streams: streams
      .filter((stream) => (stream.subscriptionIds as string[] | undefined)?.includes(String(sub.id)))
      .map((stream) => stream as unknown as Stream) }))
  }

  private async encode(collection: Collection, data: Record<string, unknown>): Promise<Fields> {
    const fields: Fields = {}
    for (const [name, value] of Object.entries(data)) {
      const key = name === 'subscription' ? 'subscriptionIds' : name === 'stream' ? 'streamIds' : name
      const field = FIELD[collection][key]
      if (!field) throw new Error(`Unknown ${collection} field: ${name}`)
      let encoded = value
      if ((name === 'subscription' || name === 'stream') && value !== null && value !== undefined) {
        const target = name === 'subscription' ? 'subscriptions' : 'subscription-streams'
        const row = (await this.rows(target)).find((r) => r.record_id === String(value))
        if (!row) throw new Error(`Unknown ${target} record ${value}`)
        encoded = [row.record_id]
      }
      if (value === null || value === undefined) encoded = null
      else if (LINK_FIELDS.has(key) && name !== 'subscription' && name !== 'stream') encoded = (value as unknown[]).map(String)
      else if (JSON_FIELDS.has(key)) encoded = JSON.stringify(encoded)
      else if (DATE_FIELDS.has(key)) encoded = new Date(String(encoded)).getTime()
      else if (SELECT_FIELDS.has(key)) encoded = String(encoded)
      fields[field] = encoded
    }
    return fields
  }

  async create<T>(name: string, data: Record<string, unknown>): Promise<T> {
    const collection = name as Collection
    const fields = await this.encode(collection, data)
    const result = await this.request<{ record?: BaseRecord }>('POST', this.path(collection), { fields })
    const record = result.record
    if (!record?.record_id) throw new Error(`Feishu create returned no record ID for ${name}`)
    const rows = this.cache.get(collection)
    if (rows) rows.push({ record_id: record.record_id, fields: record.fields ?? fields })
    return { id: record.record_id, ...data } as T
  }

  async update<T>(name: string, id: string | number, data: Record<string, unknown>): Promise<T> {
    const collection = name as Collection
    const fields = await this.encode(collection, data)
    await this.request<{ record?: BaseRecord }>('PUT', `${this.path(collection)}/${id}`, { fields })
    const row = (await this.rows(collection)).find((item) => item.record_id === String(id))
    if (row) Object.assign(row.fields, fields)
    return (row ? await this.materialize(collection, row) : { id, ...data }) as T
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined || a === '') return -1
  if (b === null || b === undefined || b === '') return 1
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}
function matches(record: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true
  if (Array.isArray(where.and)) return where.and.every((part) => matches(record, part as Record<string, unknown>))
  if (Array.isArray(where.or)) return where.or.some((part) => matches(record, part as Record<string, unknown>))
  return Object.entries(where).every(([path, condition]) => {
    const value = path.split('.').reduce<unknown>((current, segment) =>
      current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined, record)
    if (!condition || typeof condition !== 'object') return value === condition
    const op = condition as Record<string, unknown>
    return Object.entries(op).every(([operator, target]) => {
      if (operator === 'equals') return value === target
      if (operator === 'in') return Array.isArray(target) && target.includes(value)
      if (operator === 'less_than') return compare(value, target) < 0
      if (operator === 'less_than_equal') return compare(value, target) <= 0
      if (operator === 'greater_than_equal') return compare(value, target) >= 0
      return false
    })
  })
}

export { errorMessage }
