import { describe, expect, it } from 'vitest';
import { dedupePriority, newsDedupeKey } from '../src/runtime.js';

describe('news dedupe contract', () => {
  it('is stable for the same source event', () => {
    expect(newsDedupeKey('codex', '1')).toBe(newsDedupeKey('codex', '1'));
    expect(newsDedupeKey('codex', '1')).not.toBe(newsDedupeKey('codex', '2'));
    expect(newsDedupeKey('codex', '1')).not.toBe(newsDedupeKey('other', '1'));
  });

  it('prefers explicitly ranked canonical content', () => {
    expect(dedupePriority({ dedupePriority: 10 })).toBeGreaterThan(dedupePriority({ dedupePriority: 0 }));
    expect(dedupePriority({ dedupePriority: '10' })).toBe(0);
  });
});
