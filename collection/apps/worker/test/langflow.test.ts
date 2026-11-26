import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkerConfig } from '../src/config.js'
import { LangflowClient } from '../src/langflow.js'

const config: WorkerConfig = {
  FEISHU_APP_ID: 'test',
  FEISHU_APP_SECRET: 'test',
  FEISHU_BASE_TOKEN: 'test',
  FEISHU_TABLE_IDS: {},
  SOURCE_DB_PATH: '/tmp/ai-news-radar-test.sqlite',
  LANGFLOW_URL: 'https://langflow.example.test',
  LANGFLOW_API_KEY: 'langflow-key',
  LANGFLOW_FLOW_ID: 'news-processing-v1',
  LANGFLOW_TIMEOUT_MS: 60_000,
  LLM_MODEL: 'test-model',
}

const item = {
  source: 'test',
  kind: 'news' as const,
  externalId: 'news-1',
  title: 'A model shipped',
  url: 'https://example.test/news-1',
  publishedAt: new Date('2026-09-08T12:00:00.000Z'),
  content: '  Model details.  ',
  metadata: { language: 'en' },
}

const publisher = { id: 1, key: 'openai', name: 'OpenAI' }
const product = { id: 2, key: 'codex', name: 'Codex' }
const stream = {
  id: 8,
  key: 'codex-release',
  name: 'Release',
  kind: 'release' as const,
  enabled: true,
  processingMode: 'alert_digest' as const,
  maxItems: 30,
}
const subscription = {
  id: 7,
  key: 'codex',
  name: 'Codex',
  enabled: true,
  connectorType: 'github' as const,
  publisher,
  product,
  publisherKey: 'openai',
  productKey: 'codex',
  streams: [stream],
}
const source = {
  publisher,
  product,
  subscription: { id: 7, key: 'codex', name: 'Codex', connectorType: 'github' as const },
  stream: { id: 8, key: 'codex-release', name: 'Release', kind: 'release' as const },
}

describe('LangflowClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hashes the active graph and validates structured flow output', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/flows/news-processing-v1') {
        return Response.json({ id: 'ignored', data: { nodes: [{ id: 'model-a', data: { type: 'LanguageModelComponent' } }], edges: [] } })
      }
      return Response.json({ outputs: [{ outputs: [{ results: { message: { text: '```json\n{"schemaVersion":1,"cleanedContent":"Model details.","summary":"发布了模型。","topics":["模型"]}\n```' } } }] }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new LangflowClient(config).process({
      schemaVersion: 2,
      newsItemId: 9,
      title: item.title,
      kind: item.kind,
      url: item.url,
      rawContent: item.content,
      publishedAtSource: item.publishedAt.toISOString(),
      metadata: item.metadata,
      source,
    })

    expect(result.flowVersion).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.output).toEqual({ schemaVersion: 1, cleanedContent: 'Model details.', summary: '发布了模型。', topics: ['模型'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, runInit] = fetchMock.mock.calls[1]!
    expect(runInit?.headers).toMatchObject({ 'x-api-key': 'langflow-key' })
    expect(JSON.parse(String(runInit?.body))).toMatchObject({ input_type: 'chat', output_type: 'chat', session_id: 'news-item:9' })
    expect(JSON.parse(String(runInit?.body))).toMatchObject({
      tweaks: {
        'model-a': {
          model: [{ name: 'test-model', provider: 'OpenAI', category: 'OpenAI', metadata: {} }],
          model_name: 'test-model',
          provider: 'OpenAI',
        },
      },
    })
  })

  it('rejects prose that does not satisfy the processing contract', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      return path.includes('/flows/')
        ? Response.json({ data: { nodes: [], edges: [] } })
        : Response.json({ outputs: [{ outputs: [{ results: { message: { text: 'not json' } } }] }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new LangflowClient(config).process({
      schemaVersion: 2,
      newsItemId: 9,
      title: item.title,
      kind: item.kind,
      url: item.url,
      rawContent: item.content,
      publishedAtSource: item.publishedAt.toISOString(),
      metadata: item.metadata,
      source,
    })).rejects.toThrow('Langflow output was not valid JSON')
  })
})

describe('NewsProcessor', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stores processed content in Base', async () => {
    const update = vi.fn(async () => ({}))
    const base = { update } as unknown as import('../src/base.js').BaseClient
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.includes('/flows/')) return Response.json({ data: { nodes: [], edges: [] } })
      return Response.json({ outputs: [{ outputs: [{ results: { message: { text: '{"schemaVersion":1,"cleanedContent":"Model details.","summary":"发布了模型。","topics":["模型"]}' } } }] }] })
    }))
    const processor = new (await import('../src/langflow.js')).NewsProcessor(config, base)
    await expect(processor.process('n1', item, subscription, stream)).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith('news-items', 'n1', { processedContent: 'Model details.', editorialSummary: '发布了模型。', topics: ['模型'] })
  })
})
