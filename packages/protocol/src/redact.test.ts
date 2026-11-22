import { describe, expect, test } from 'vitest';
import {
  containsSecret,
  dropSecrets,
  findPrivateKeys,
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

// GitLab (#539): every gl*- prefix, legacy and routable `glpat-`, built at run time like the rest.
const gl = (prefix: string) => 'gl' + prefix + '-';
const legacyGlpat = gl('pat') + 'Ab1_-Cd2'.repeat(2) + 'Ef3G';
const routableGlpat = gl('pat') + 'Qw9-Er8_Ty7Ui6'.repeat(3) + '.01.' + 'zx81cv72b';
const gitlabKinds: [string, string][] = [
  ['legacy glpat-', legacyGlpat],
  ['routable glpat-', routableGlpat],
  ...['oas', 'dt', 'rt', 'cbt', 'ptt', 'ft', 'imt', 'agent', 'soat'].map((p): [string, string] => [
    `gl${p}-`,
    gl(p) + 'Mn4Op5Qr6St7Uv8Wx9Yz',
  ]),
];

describe('redactTokenShapes catches each token kind in each position', () => {
  test.each(
    [...tokenKinds, ...gitlabKinds].flatMap(([kind, token]) =>
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

describe('findPrivateKeys', () => {
  // Built at run time, so this file's own source holds no key block.
  const begin = (label: string) => `-----BEGIN ${label}PRIVATE KEY-----`;
  const end = (label: string) => `-----END ${label}PRIVATE KEY-----`;
  const body = (n: number) => 'MIIEo+/='.repeat(Math.ceil(n / 8)).slice(0, n);
  /** `n` base64 body characters in 64-character lines. */
  const block = (label: string, n: number, nl = '\n') =>
    [begin(label), ...(body(n).match(/.{1,64}/g) ?? []), end(label)].join(nl);

  test.each(['RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', 'DSA ', ''])(
    'finds a %sblock with LF, CRLF and JSON-escaped newlines',
    (label) => {
      for (const nl of ['\n', '\r\n', '\\n', '\\r\\n']) {
        const key = block(label, 1700, nl);
        const text = `x = "${key}" y`;
        expect(findPrivateKeys(text)).toEqual([{ start: 5, end: 5 + key.length, real: true }]);
      }
    },
  );

  test('finds a JSON-escaped key in a transcript line', () => {
    const line = JSON.stringify({ text: `here: ${block('RSA ', 1700)}` });
    expect(line).not.toContain('\n');
    expect(findPrivateKeys(line)).toHaveLength(1);
    expect(findPrivateKeys(line)[0]?.real).toBe(true);
    expect(redact(line, [])).toBe(JSON.stringify({ text: 'here: [REDACTED PRIVATE KEY]' }));
  });

  test('real at 200 base64 body characters, not at 199', () => {
    expect(findPrivateKeys(block('RSA ', 200))[0]?.real).toBe(true);
    expect(findPrivateKeys(block('RSA ', 199))[0]?.real).toBe(false);
    expect(findPrivateKeys(block('', 200, '\\n'))[0]?.real).toBe(true);
    expect(findPrivateKeys(block('', 199, '\\r\\n'))[0]?.real).toBe(false);
  });

  test('Proc-Type and DEK-Info header fields are not counted', () => {
    const fields = [
      'Proc-Type: 4,ENCRYPTED',
      `DEK-Info: AES-256-CBC,${'ABCDEF0123456789'.repeat(8)}`,
    ];
    for (const nl of ['\n', '\\n']) {
      const key = [begin('RSA '), ...fields, '', body(199), end('RSA ')].join(nl);
      expect(findPrivateKeys(key)[0]?.real).toBe(false);
      const more = [begin('RSA '), ...fields, '', body(200), end('RSA ')].join(nl);
      expect(findPrivateKeys(more)[0]?.real).toBe(true);
    }
  });

  test('a header without a footer runs to the end of the text', () => {
    const text = `a ${begin('EC ')}\n${body(300)}\nmore`;
    expect(findPrivateKeys(text)).toEqual([{ start: 2, end: text.length, real: true }]);
    const short = `a ${begin('EC ')}\n${body(20)}`;
    expect(findPrivateKeys(short)).toEqual([{ start: 2, end: short.length, real: false }]);
  });

  test('a footer with another label does not end the block', () => {
    const text = `${begin('RSA ')}\n${body(100)}\n${end('EC ')}\n${body(150)}`;
    expect(findPrivateKeys(text)).toEqual([{ start: 0, end: text.length, real: true }]);
  });

  test('finds every block, and nothing in text without one', () => {
    const text = `${block('RSA ', 30)}\nmid\n${block('OPENSSH ', 900)}`;
    expect(findPrivateKeys(text).map((k) => k.real)).toEqual([false, true]);
    expect(findPrivateKeys('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----')).toEqual(
      [],
    );
    expect(findPrivateKeys('BEGIN rsa private key')).toEqual([]);
  });

  test('both redact functions replace every block, real or fake', () => {
    const text = `a ${block('RSA ', 30)} b ${block('', 1700, '\r\n')} c`;
    const want = 'a [REDACTED PRIVATE KEY] b [REDACTED PRIVATE KEY] c';
    expect(redactTokenShapes(text)).toBe(want);
    expect(redact(text, [])).toBe(want);
    expect(redact(`${text} s3cret`, ['s3cret'])).toBe(`${want} [REDACTED]`);
    expect(redactTokenShapes(`x ${begin('DSA ')}\nAAAA`)).toBe('x [REDACTED PRIVATE KEY]');
  });
});

describe('GitLab token shapes', () => {
  test('a legacy glpat- token in a sentence is redacted, the text and a sentence-ending . kept', () => {
    expect(legacyGlpat.length).toBe(26);
    expect(redact(`token ${legacyGlpat} here`, [])).toBe('token [REDACTED] here');
    expect(redactTokenShapes(`use ${legacyGlpat}. Next`)).toBe('use [REDACTED]. Next');
  });

  test('a routable glpat- token is replaced whole', () => {
    const out = redactTokenShapes(`a ${routableGlpat} b`);
    expect(out).toBe('a [REDACTED] b');
    expect(survivors(out, routableGlpat)).toEqual([]);
  });

  test.each([
    'glpat-short',
    'glpat-',
    'a bare glpat- here',
    'use-glpat-format-helper',
    'my_glpat_value',
  ])('%s is not a token', (text) => {
    expect(redactTokenShapes(text)).toBe(text);
    expect(containsSecret(text, [])).toBe(false);
  });

  test('containsSecret finds a glpat- token and another gl*- prefix', () => {
    expect(containsSecret(`+const t = "${legacyGlpat}";`, [])).toBe(true);
    expect(containsSecret(`+const t = "${routableGlpat}";`, [])).toBe(true);
    expect(containsSecret(`deploy ${gl('dt')}Mn4Op5Qr6St7Uv8Wx9Yz`, [])).toBe(true);
  });

  test("this test file's own source holds no token-shaped literal", async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./redact.test.ts', import.meta.url), 'utf8');
    expect(containsSecret(source, [])).toBe(false);
  });
});

// #642: the stateless installation token shape is matched in linear time.
describe('stateless token shape in linear time', () => {
  const N = 116_509; // 'ghs_0_eyJ'.length * N ≈ 1 MB
  const run = (n: number) => 'ghs_0_eyJ'.repeat(n);
  const adversarial: [string, string][] = [
    ['fails at the first segment', 'x' + run(N) + '!'],
    ['empty second segment', 'x' + run(N) + '.!'],
    ['second segment not followed by a dot', 'x' + run(N) + '.' + 'a'.repeat(9 * N) + '!'],
  ];
  const timed = <T>(f: () => T): [T, number] => {
    const t0 = performance.now();
    const r = f();
    return [r, performance.now() - t0];
  };

  test.each(adversarial)('%s: every entry point completes in under 2s', (_name, s) => {
    const [shaped, t1] = timed(() => redactTokenShapes(s));
    expect(shaped).toBe(s);
    expect(t1).toBeLessThan(2000);
    const [red, t2] = timed(() => redact(s, ['some-secret-value']));
    expect(red).toBe(s);
    expect(t2).toBeLessThan(2000);
    const [found, t3] = timed(() => containsSecret(s, []));
    expect(found).toBe(false);
    expect(t3).toBeLessThan(2000);
  });

  // Today's list, copied as the oracle (#642), applied in order with String.prototype.replace.
  const ORACLE = [
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /ghs_\d+_eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9._-]{36,}/g,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/]{20,}={0,2}/g,
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    /jmm_[A-Za-z0-9_-]{20,}/g,
    /gl(?:pat|oas|dt|rt|cbt|ptt|ft|imt|agent|soat)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
  ];
  const oracle = (s: string) => ORACLE.reduce((out, re) => out.replace(re, '[REDACTED]'), s);
  // Built at runtime so no token-shaped literal sits in the tracked file.
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'aB3-_x'.repeat(40) + '.' + 'Zz9_-q'.repeat(40);
  const token = ['ghs', '5761534', jwt].join('_');
  const equivalence: string[] = [
    token,
    `auth ${token} end`,
    `n${token}`,
    `m${token}`,
    `_${token}`,
    `x-access-token%3A${token}`,
    JSON.stringify({ log: `line\n${token}\nnext` }),
    `${token} ${token}`,
    `the token was ${token}.`,
    ['ghs', '1', 'eyJa.b.'].join('_'),
    `n${['ghs', '1', 'eyJa.b.'].join('_')}`,
    ['ghs', 'x', 'eyJa.b.c'].join('_'),
    `n${['ghs', 'x', 'eyJa.b.c'].join('_')}`,
    `n${['ghs', '1', 'eyJa.b.c'].join('_')}.d.e`,
    `n${['ghs', '1', 'eyJa'].join('_')}${['ghs', '2', 'eyJb.c.d'].join('_')}`,
    `n${['ghs', '1', 'eyJa.b'].join('_')}${['ghs', '2', 'eyJb.c.d'].join('_')}`,
    `n${['ghs', '1', 'eyJa.'].join('_')}${['ghs', '2', 'eyJb.c.d'].join('_')}`,
    `n${['ghs', '12', ''].join('_')}${['ghs', '2', 'eyJb.c.d'].join('_')}`,
    `n${['ghs', '1', 'eyJ'].join('_')}.b.c`,
    'x' + run(50) + '!',
    'x' + run(50) + '.!',
    'x' + run(50) + '.aaa!',
    'x' + run(50) + '.aaa.b',
  ];
  test.each(equivalence)('matches what the previous pattern matched: %j', (s) => {
    expect(redactTokenShapes(s)).toBe(oracle(s));
  });

  test('a token in the middle of a long adversarial run is still redacted', () => {
    const s = 'x' + run(N) + 'n' + token + run(N) + '!';
    const [out, t] = timed(() => redactTokenShapes(s));
    expect(t).toBeLessThan(2000);
    expect(out.includes(jwt)).toBe(false);
    for (const part of jwt.split('.')) expect(out.includes(part)).toBe(false);
  });

  test('a token right after a word character is still redacted', () => {
    expect(redactTokenShapes(`n${token}`)).toBe('n[REDACTED]');
    expect(containsSecret(`n${token}`, [])).toBe(true);
  });
});
