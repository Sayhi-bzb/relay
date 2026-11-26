import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceCatalog } from '../src/sqlite.js'

const paths: string[] = []
const subscription = {
  id: 'sub-1', key: 'codex', name: 'Codex', enabled: true,
  publisher: { id: 'publisher', key: 'openai', name: 'OpenAI' },
  product: { id: 'product', key: 'codex', name: 'Codex' }, publisherKey: 'openai', productKey: 'codex',
  connectorType: 'github' as const, githubConfig: { repository: 'openai/codex' }, streams: [],
}
const stream = { id: 'stream-1', key: 'codex-release', name: 'Release', kind: 'release' as const, enabled: true, maxItems: 30 }

function catalog() {
  const path = join(tmpdir(), `ai-news-radar-${Date.now()}-${Math.random()}.sqlite`)
  paths.push(path)
  return new SourceCatalog(path)
}

afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true }) })

describe('SourceCatalog', () => {
  it('persists source events idempotently and tracks the pending queue', () => {
    const db = catalog()
    const item = { source: 'github', kind: 'release' as const, externalId: 'v1', title: 'Release',
      url: 'https://example.test/v1', publishedAt: new Date('2026-10-11T00:00:00Z'), metadata: {} }
    expect(db.upsert(subscription, stream, item).inserted).toBe(true)
    expect(db.upsert(subscription, stream, item).inserted).toBe(false)
    expect(db.knownExternalIds('codex')).toEqual(new Set(['v1']))
    expect(db.pending()).toHaveLength(1)
    expect(db.payload(db.pending()[0]!).externalId).toBe('v1')
    db.upsert(subscription, { ...stream, kind: 'pull_request' }, { ...item, kind: 'pull_request', externalId: 'pr1' })
    expect(db.pending(2000, ['release', 'changelog']).map((row) => row.externalId)).toEqual(['v1'])
    expect(db.pending(2000, [])).toEqual([])
    db.markArchived(1, 'rec-news-1')
    expect(db.pending(2000, ['release', 'changelog'])).toHaveLength(0)
    expect(db.pending()).toHaveLength(1)
    db.close()
  })
})
