import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './types.js';

for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_BASE_TOKEN: z.string().min(1),
  FEISHU_TABLE_IDS: z.string().transform((value) => z.record(z.string(), z.string().min(1)).parse(JSON.parse(value))),
  GITHUB_TOKEN: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),
  LANGFLOW_URL: z.string().url().optional(),
  LANGFLOW_API_KEY: z.string().min(1).optional(),
  LANGFLOW_FLOW_ID: z.string().min(1).optional(),
  LANGFLOW_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SOURCE_DB_PATH: z.string().default('/var/lib/ai-news-radar/source.sqlite'),
  OBSIDIAN_VAULT_PATH: z.string().optional(),
});

export type WorkerConfig = z.infer<typeof schema>;
export function loadConfig(): WorkerConfig { return schema.parse(process.env); }
export type { AppConfig };
