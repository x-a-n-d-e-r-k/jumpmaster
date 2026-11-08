import { expect, test } from 'vitest';
import { payloadSecrets, redact } from './redact.js';

test('redacts known secrets and token shapes', () => {
  expect(redact('a sekret b ghp_' + 'x'.repeat(36), ['sekret'])).toBe('a [REDACTED] b [REDACTED]');
  expect(redact('k sk-ant-' + 'a1_-'.repeat(8), [])).toBe('k [REDACTED]');
});
test('escapes regex metacharacters and ignores empty secrets', () => {
  expect(redact('x a.b*c(d y axbbc', ['a.b*c(d', ''])).toBe('x [REDACTED] y axbbc');
});

test('redacts fine-grained GitHub PATs', () => {
  expect(redact(`t github_pat_${'A1_'.repeat(10)} e`, [])).toBe('t [REDACTED] e');
});

test('payloadSecrets lists every credential a drop carries', () => {
  const s = payloadSecrets({
    credentials: { claudeToken: 'claude-tok', forgeToken: 'forge-tok' },
    gateSecrets: { DB: 'db-pass' },
  });
  expect(s).toEqual([
    'db-pass',
    'claude-tok',
    'forge-tok',
    Buffer.from('x-access-token:forge-tok').toString('base64'),
  ]);
  expect(payloadSecrets({ credentials: { claudeToken: 'c' } })).toEqual(['c']);
});
