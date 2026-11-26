import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseClient } from '../src/base.js'

const ids = { Subscriptions: 'sub', Streams: 'stream', News: 'news', Digests: 'digest', Settings: 'settings' }
const config = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_BASE_TOKEN: 'base', FEISHU_TABLE_IDS: ids }
function response(data: unknown) { return Response.json({ code: 0, data }) }

describe('minimal BaseClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads legacy and current source labels, denormalized catalogs, and stream cursors', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (path.includes('/sub/records')) return response({ items: [{ record_id: 's1', fields: {
        名称: 'Codex', 标识: 'codex', 启用: true, 接入类型: 'github', 机构: 'OpenAI', 机构标识: 'openai',
        产品: 'Codex', 产品标识: 'codex', 来源地址: 'openai/codex',
      } }] })
      if (path.includes('/stream/records')) return response({ items: [{ record_id: 't1', fields: {
        名称: 'Release', 标识: 'release', 订阅: [{ record_ids: ['s1'], text: 'Codex' }], 启用: true, 内容类型: 'release', 每轮上限: '30',
        上次成功: Date.parse('2026-09-28T12:00:00Z'),
      } }] })
      throw new Error(`Unexpected ${path}`)
    }))
    const base = new BaseClient(config)
    expect(await base.subscriptions()).toMatchObject([{ publisher: { key: 'openai', name: 'OpenAI' },
      githubConfig: { repository: 'openai/codex' }, streams: [{ maxItems: 30, lastSuccessAt: '2026-09-28T12:00:00.000Z' }] }])
  })

  it('allows repeated source types while requiring distinct subscription keys', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (path.includes('/sub/records')) return response({ items: [
        { record_id: 's1', fields: { 来源类型: 'GitHub', 标识: 'codex', 启用: true, 机构: 'OpenAI', 产品: 'Codex' } },
        { record_id: 's2', fields: { 来源类型: 'GitHub', 标识: 'pi', 启用: true, 机构: 'Earendil Works', 产品: 'Pi' } },
      ] })
      if (path.includes('/stream/records')) return response({ items: [] })
      throw new Error(`Unexpected ${path}`)
    }))
    expect((await new BaseClient(config).subscriptions()).map(({ name, key }) => [name, key]))
      .toEqual([['GitHub', 'codex'], ['GitHub', 'pi']])
  })

  it('rejects repeated subscription keys', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (path.includes('/sub/records')) return response({ items: [
        { record_id: 's1', fields: { 来源类型: 'GitHub', 标识: 'same', 启用: true } },
        { record_id: 's2', fields: { 来源类型: 'News', 标识: 'same', 启用: false } },
      ] })
      if (path.includes('/stream/records')) return response({ items: [] })
      throw new Error(`Unexpected ${path}`)
    }))
    await expect(new BaseClient(config).subscriptions()).rejects.toThrow('Subscription keys must be nonempty and unique')
  })

  it('writes native record links for news and digests', async () => {
    const calls: Array<{ method?: string; fields: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (init?.method === 'POST' || init?.method === 'PUT') {
        const fields = JSON.parse(String(init.body)).fields
        calls.push({ method: init.method, fields })
        return response({ record: { record_id: 'n1', fields } })
      }
      if (path.includes('/sub/records')) return response({ items: [{ record_id: 's1', fields: { 标识: 'codex' } }] })
      if (path.includes('/stream/records')) return response({ items: [{ record_id: 't1', fields: { 标识: 'release' } }] })
      if (path.includes('/news/records')) return response({ items: [] })
      throw new Error(`Unexpected ${path}`)
    }))
    const base = new BaseClient(config)
    await base.list('news-items')
    const news = await base.create<{ id: string }>('news-items', { title: 'Launch', url: 'https://example.test',
      subscription: 's1', subscriptionKey: 'codex', stream: 't1', kind: 'release', publishedAtSource: '2026-09-28T12:00:00Z', metadata: {} })
    expect(news.id).toBe('n1')
    expect(calls[0]?.fields).toMatchObject({ 标题: 'Launch', 订阅: ['s1'], 订阅标识: 'codex', 栏目: ['t1'], 内容类型: 'release',
      发布时间: Date.parse('2026-09-28T12:00:00Z'), 元数据: '{}' })
    await base.create('digests', { digestDate: '2026-09-28', items: ['n1'] })
    expect(calls[1]?.fields).toMatchObject({ 日期: '2026-09-28', 动态: ['n1'] })
    expect((await base.list<{ subscription: { key: string }; stream: { key: string } }>('news-items', { depth: 1 })).docs[0])
      .toMatchObject({ subscription: { key: 'codex' }, stream: { key: 'release' } })
  })
})
