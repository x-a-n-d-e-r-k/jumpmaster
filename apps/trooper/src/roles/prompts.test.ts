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
