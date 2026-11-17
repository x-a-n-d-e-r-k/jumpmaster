import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const prompt = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../prompts', name), 'utf8');

describe('the drop-ready format in the prompts (#198)', () => {
  test.each(['crew-lead.md', 'refute.md', 'triage.md'])(
    '%s names the drop-ready format',
    (name) => {
      const text = prompt(name);
      expect(text).toContain('drop-ready format');
      expect(text).not.toContain('agent-ready');
    },
  );
});

describe('finishing an objective (#245)', () => {
  test('the crew lead reports objectiveDone once every part has merged, not a free-text briefing', () => {
    const text = prompt('crew-lead.md');
    expect(text).toMatch(
      /every part of the current objective has merged, report it with `objectiveDone`/,
    );
    expect(text).toMatch(/instead of raising a free-text briefing/);
  });
});

describe('one open briefing per objective (#246)', () => {
  test('the crew lead reuses an open briefing for the current objective instead of raising another', () => {
    const text = prompt('crew-lead.md');
    expect(text).toMatch(/While a briefing is open for the current objective/);
    expect(text).toMatch(/don't raise another; reuse its subject to update it/);
  });
});
