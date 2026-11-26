import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { WorkerConfig } from './config.js'
import { BaseClient } from './base.js'
import { subscriptionLabel } from './types.js'
import type { CatalogRelation, ItemKind, PayloadID, SourceItem, Stream, Subscription } from './types.js'

export const newsProcessingOutputSchema = z.object({
  schemaVersion: z.literal(1),
  cleanedContent: z.string().trim(),
  summary: z.string().trim().min(1),
  topics: z.array(z.string().trim().min(1)).max(12),
})

export type NewsProcessingOutput = z.infer<typeof newsProcessingOutputSchema>

export type NewsProcessingInput = {
  schemaVersion: 2
  newsItemId: PayloadID
  title: string
  kind: ItemKind
  url: string
  rawContent: string | null
  publishedAtSource: string
  metadata: Record<string, unknown>
  source: {
    publisher: CatalogRelation | null
    product: CatalogRelation | null
    subscription: Pick<Subscription, 'id' | 'key' | 'name' | 'connectorType'>
    stream: Pick<Stream, 'id' | 'key' | 'name' | 'kind'>
  }
}

const MAX_RAW_CONTENT_LENGTH = 12_000

type FlowDescriptor = { flowVersion: string; modelNodeIds: string[] }

export class LangflowClient {
  readonly enabled: boolean
  readonly flowId: string
  private readonly apiKey?: string
  private readonly baseUrl?: string
  private readonly modelName?: string
  private readonly timeoutMs: number
  private readonly flowDescriptors = new Map<string, Promise<FlowDescriptor>>()

  constructor(config: WorkerConfig) {
    this.apiKey = config.LANGFLOW_API_KEY
    this.baseUrl = config.LANGFLOW_URL
    this.flowId = config.LANGFLOW_FLOW_ID ?? ''
    this.modelName = config.LLM_MODEL
    this.timeoutMs = config.LANGFLOW_TIMEOUT_MS
    this.enabled = Boolean(this.apiKey && this.baseUrl && this.flowId && config.LLM_MODEL)
  }

  async process(input: NewsProcessingInput, flowId = this.flowId): Promise<{ output: NewsProcessingOutput; flowVersion: string }> {
    if (!this.enabled || !this.baseUrl || !this.apiKey) throw new Error('Langflow is not configured')
    if (!flowId) throw new Error('Langflow flow ID is not configured')
    const { flowVersion, modelNodeIds } = await this.resolveFlowDescriptor(flowId)
    const tweaks = Object.fromEntries(modelNodeIds.map((nodeId) => [nodeId, {
      model: [{ name: this.modelName, provider: 'OpenAI', category: 'OpenAI', metadata: {} }],
      model_name: this.modelName,
      provider: 'OpenAI',
    }]))
    const response = await this.request<unknown>(`/api/v1/run/${encodeURIComponent(flowId)}?stream=false`, {
      method: 'POST',
      body: JSON.stringify({
        input_type: 'chat',
        input_value: JSON.stringify(input),
        output_type: 'chat',
        session_id: `news-item:${input.newsItemId}`,
        tweaks,
      }),
    })
    const text = langflowResponseText(response)
    return { flowVersion, output: newsProcessingOutputSchema.parse(parseJsonText(text)) }
  }

  private async fetchFlowDescriptor(flowId: string): Promise<FlowDescriptor> {
    const flow = await this.request<unknown>(`/api/v1/flows/${encodeURIComponent(flowId)}`)
    const definition = isRecord(flow) && 'data' in flow ? flow.data : flow
    const nodes = isRecord(definition) && Array.isArray(definition.nodes) ? definition.nodes : []
    const modelNodeIds = nodes.flatMap((node) => {
      if (!isRecord(node) || typeof node.id !== 'string' || !isRecord(node.data)) return []
      return node.data.type === 'LanguageModelComponent' ? [node.id] : []
    })
    return {
      flowVersion: `sha256:${createHash('sha256').update(stableJson(definition)).digest('hex')}`,
      modelNodeIds,
    }
  }

  private async resolveFlowDescriptor(flowId: string): Promise<FlowDescriptor> {
    const pending = this.flowDescriptors.get(flowId) ?? this.fetchFlowDescriptor(flowId)
    this.flowDescriptors.set(flowId, pending)
    try { return await pending }
    catch (error) {
      this.flowDescriptors.delete(flowId)
      throw error
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey!, ...init.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`Langflow ${response.status}: ${(await response.text()).slice(0, 500)}`)
    return response.json() as Promise<T>
  }
}

export class NewsProcessor {
  readonly enabled: boolean
  private readonly langflow: LangflowClient

  constructor(config: WorkerConfig, private readonly payload: BaseClient) {
    this.langflow = new LangflowClient(config)
    this.enabled = this.langflow.enabled
  }

  async smoke(input: NewsProcessingInput) {
    return this.langflow.process(input)
  }

  async process(newsItemId: PayloadID, item: SourceItem, subscription: Subscription, stream: Stream): Promise<boolean> {
    if (!this.enabled) return false
    const flowId = stream.langflowProductionFlowId?.trim() || this.langflow.flowId
    const input: NewsProcessingInput = {
      schemaVersion: 2,
      newsItemId,
      title: item.title,
      kind: item.kind,
      url: item.url,
      rawContent: item.content?.slice(0, MAX_RAW_CONTENT_LENGTH) ?? null,
      publishedAtSource: item.publishedAt.toISOString(),
      metadata: item.metadata,
      source: {
        publisher: subscription.publisher,
        product: subscription.product,
        subscription: {
          id: subscription.id,
          key: subscription.key,
          name: subscriptionLabel(subscription),
          connectorType: subscription.connectorType,
        },
        stream: { id: stream.id, key: stream.key, name: stream.name, kind: stream.kind },
      },
    }
    try {
      const { output } = await this.langflow.process(input, flowId)
      await this.payload.update('news-items', newsItemId, {
        processedContent: output.cleanedContent || null,
        editorialSummary: output.summary,
        topics: output.topics,
      })
      return true
    } catch (error) {
      console.error(JSON.stringify({ newsItemId, processor: 'langflow', error: errorMessage(error) }))
      return false
    }
  }
}

export function langflowResponseText(value: unknown): string {
  const outputs = isRecord(value) && Array.isArray(value.outputs) ? value.outputs : []
  for (const outer of outputs) {
    const nested = isRecord(outer) && Array.isArray(outer.outputs) ? outer.outputs : []
    for (const output of nested) {
      if (!isRecord(output)) continue
      const results = isRecord(output.results) ? output.results : undefined
      const message = results && isRecord(results.message) ? results.message : undefined
      if (message && typeof message.text === 'string') return message.text
      if (typeof output.text === 'string') return output.text
    }
  }
  if (isRecord(value) && typeof value.text === 'string') return value.text
  throw new Error('Langflow response did not contain output text')
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  try { return JSON.parse(fenced?.[1] ?? trimmed) }
  catch { throw new Error('Langflow output was not valid JSON') }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
