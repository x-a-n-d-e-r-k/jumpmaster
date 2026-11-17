import { describe, expect, test } from 'vitest';
import {
  containsSecret,
  dropSecrets,
  payloadSecrets,
  redact,
  redactTokenShapes,
} from './redact.js';

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
const jwtPart = (n: number) =>
  'eyJhbGciOiJSUzI1NiJ9.' + 'aB3-_x'.repeat(n) + '.' + 'Zz9_-q'.repeat(n);
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

test('a snake_case name containing ghs_ is not a token', () => {
  const line = '+const highs_and_lows_for_each_trading_day_in_range = 1;';
  expect(containsSecret(line, [])).toBe(false);
  expect(redact(line, [])).toBe(line);
});

test('dropSecrets lists basic-auth forms and nothing else', () => {
  const b64 = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');
  expect(
    dropSecrets({
      forgeToken: 'forge-tok',
      authorToken: 'author-tok',
      claudeToken: 'claude-tok',
      gateSecrets: { A: 'gate-a' },
    }),
  ).toEqual([
    'gate-a',
    'claude-tok',
    'forge-tok',
    b64('forge-tok'),
    'author-tok',
    b64('author-tok'),
  ]);
  expect(dropSecrets({ authorToken: 'a', claudeToken: 'c' })).toEqual(['c', 'a', b64('a')]);
});

test('withBasicAuth is exported from the package and pairs a token with its git basic-auth form', async () => {
  const { withBasicAuth } = await import('./index.js');
  expect(withBasicAuth('ghs_abc')).toEqual([
    'ghs_abc',
    Buffer.from('x-access-token:ghs_abc').toString('base64'),
  ]);
  expect(withBasicAuth(undefined)).toEqual([]);
});

// D4 evasion (#253): every GitHub token kind, in every position a sink sees it, leaves no part behind.
// Built by concatenation so no token-shaped literal sits in the tracked file.
const statelessToken = 'ghs' + '_1234567_' + jwtPart(12);
const tokenKinds: [string, string][] = [
  ['stateless ghs_', statelessToken],
  ['classic ghp_', 'ghp' + '_' + 'A1b2'.repeat(9)],
  ['classic gho_', 'gho' + '_' + 'C3d4'.repeat(9)],
  ['classic 40-character ghs_', 'ghs' + '_' + 'E5f6'.repeat(9)],
  ['fine-grained github_pat_', 'github' + '_pat_' + '11AB_'.repeat(16)],
];
const positions: [string, (t: string) => string][] = [
  ['plain', (t) => ' ' + t],
  ['JSON-escaped newline', (t) => JSON.stringify('line\n' + t)],
  ['ANSI prefix', (t) => '\x1b[32m' + t],
  ['URL-encoded prefix', (t) => 'x-access-token%3A' + t],
];
const survivors = (out: string, token: string) =>
  [
    token,
    token.slice(4, 20),
    token.slice(-16),
    ...token.split(/[._]/).filter((p) => p.length >= 8),
  ].filter((part) => out.includes(part));

describe('redactTokenShapes catches each token kind in each position', () => {
  test.each(
    tokenKinds.flatMap(([kind, token]) =>
      positions.map(([where, wrap]) => ({ kind, where, token, wrap })),
    ),
  )('$kind, $where', ({ token, wrap }) => {
    const out = redactTokenShapes(wrap(token));
    expect(out).toContain('[REDACTED]');
    expect(survivors(out, token)).toEqual([]);
  });
});

test('an identifier that merely contains ghs_ is not redacted', () => {
  const id = 'highs_and_lows_of_a_long_identifier_name_here';
  expect(redactTokenShapes(id)).toBe(id);
  expect(redactTokenShapes(`const ${id} = 1;`)).toBe(`const ${id} = 1;`);
});
