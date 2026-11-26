import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { WorkerConfig } from './config.js';
import type { SourceItem } from './types.js';

type DigestItem = SourceItem & { id: string | number };

export class AiEditor {
  readonly enabled: boolean;
  private readonly model;
  constructor(config: WorkerConfig) {
    this.enabled = Boolean(config.LLM_API_KEY && config.LLM_MODEL);
    const provider = createOpenAI({ apiKey: config.LLM_API_KEY ?? 'disabled', baseURL: config.LLM_BASE_URL });
    this.model = config.LLM_MODEL ? provider(config.LLM_MODEL) : undefined;
  }

  async digest(date: string, items: DigestItem[]): Promise<{ introduction: string; markdown: string } | undefined> {
    if (!this.enabled || !this.model || items.length === 0) return undefined;
    const input = items.map((item) => ({ ref: item.id, kind: item.kind, title: item.title, url: item.url, content: item.content?.slice(0, 1800) ?? '', metadata: item.metadata }));
    const result = await generateText({
      model: this.model,
      maxOutputTokens: 3000,
      prompt: [
        `生成 ${date} 的中文 AI 工程情报日报正文。`,
        '只使用输入事实。按“今日重点、官方动态、GitHub”组织；空栏目省略。',
        '每条结论都附输入中的原文 Markdown 链接；不要编造链接、数字或未提供的因果。',
        JSON.stringify(input),
      ].join('\n'),
    });
    const markdown = result.text.trim();
    return markdown ? { introduction: `AI 编辑整理 ${items.length} 条上游动态。`, markdown: `# AI 情报日报 · ${date}\n\n${markdown}` } : undefined;
  }
}
