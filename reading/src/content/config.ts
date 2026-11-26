import { defineCollection, z } from 'astro:content';

const sources = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    source_url: z.string().url(),
    publisher: z.string(),
    author: z.string(),
    published_at: z.coerce.date(),
    retrieved_at: z.coerce.date(),
    lang: z.enum(['en', 'zh-CN']).default('en'),
    description: z.string(),
    product: z.object({ name: z.string(), slug: z.string() }).optional(),
    image_sizes: z.record(z.object({ width: z.number().int().positive(), height: z.number().int().positive() })).optional(),
  }),
});

export const collections = { sources };
