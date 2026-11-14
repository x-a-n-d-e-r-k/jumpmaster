import { expect, test } from 'vitest';
import { containsSecret, payloadSecrets, redact, redactTokenShapes } from './redact.js';

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

test('payloadSecrets includes credentials.readToken, and its git basic-auth form', () => {
  expect(payloadSecrets({ credentials: { claudeToken: 'c', readToken: 'read-tok' } })).toEqual([
    'c',
    'read-tok',
    Buffer.from('x-access-token:read-tok').toString('base64'),
  ]);
});

// A stateless installation token (F21): `ghs_<app id>_<JWT>`, hundreds of characters with `.`, `-`, `_`.
const jwtPart = (n: number) => 'eyJhbGciOiJSUzI1NiJ9.' + 'aB3-_x'.repeat(n) + '.' + 'Zz9_-q'.repeat(n);
const stateless = `ghs_5761534_${jwtPart(40)}`;

test('redacts a stateless installation token whole, however long', () => {
  expect(stateless.length).toBeGreaterThan(500);
  expect(redact(`auth ${stateless} end`, [])).toBe('auth [REDACTED] end');
  expect(redactTokenShapes(`"token":"${stateless}"`, '[x]')).toBe('"token":"[x]"');
});

test('still redacts a classic 40-character installation token', () => {
  expect(redact(`t ghs_${'A1b2'.repeat(9)} e`, [])).toBe('t [REDACTED] e');
});

test('containsSecret finds a stateless token by shape', () => {
  expect(containsSecret(`+const t = "${stateless}";`, [])).toBe(true);
});

test('redacts the git basic-auth form of any token, registered or not', () => {
  const basic = Buffer.from(`x-access-token:${stateless}`).toString('base64');
  expect(redact(`Authorization: Basic ${basic}`, [])).toBe('Authorization: Basic [REDACTED]');
  expect(containsSecret(`header ${basic}`, [])).toBe(true);
});

test('leaves short ghs_-prefixed words alone', () => {
  expect(redact('see ghs_short and ghs_ alone', [])).toBe('see ghs_short and ghs_ alone');
});
