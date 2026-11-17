import { generateKeyPairSync } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { scrub } from '../scrub.js';
import { EVICTION_WARNING, SCRUB_SET_LIMIT, ScrubSet, serverScrubSet } from './scrub-set.js';

const basic = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');
const stateless = `ghs_12345_${'eyJhbGciOiJSUzI1NiJ9'}.${'a-b_c'.repeat(20)}.${'Zz-_9'.repeat(30)}`;

test('a registered installation token and its basic-auth form are both redacted', () => {
  const set = new ScrubSet();
  set.add(stateless);
  expect(set.values()).toEqual([stateless, basic(stateless)]);
  expect(scrub(`token ${stateless} end`, undefined, [], set)).toBe('token [redacted] end');
  expect(scrub(`Authorization: Basic ${basic(stateless)}`, undefined, [], set)).toBe(
    'Authorization: Basic [redacted]',
  );
});

test('every GitHub token prefix gets its basic-auth form; other values do not', () => {
  for (const p of ['ghs_', 'ghp_', 'ghu_', 'gho_', 'ghr_', 'github_pat_']) {
    const set = new ScrubSet();
    set.add(`${p}abcdefgh`);
    expect(set.values()).toEqual([`${p}abcdefgh`, basic(`${p}abcdefgh`)]);
  }
  const set = new ScrubSet();
  set.add('eyJhbGciOiJSUzI1NiJ9.payload.sig');
  expect(set.values()).toEqual(['eyJhbGciOiJSUzI1NiJ9.payload.sig']);
});

test('addPem redacts the whole PEM, its joined body and a single line, each in one piece', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const set = new ScrubSet();
  set.addPem(privateKey);
  const lines = privateKey.split('\n').filter((l) => l && !l.startsWith('-----'));
  const body = lines.join('');
  const line = lines.find((l) => l.length === 64);
  expect(line).toBeDefined();
  for (const secret of [privateKey, body, line as string]) {
    const out = scrub(`before ${secret} after`, undefined, [], set);
    expect(out).toBe('before [redacted] after');
  }
});

test('values under 8 characters are ignored', () => {
  const set = new ScrubSet();
  set.add('short');
  set.add('1234567');
  set.add('');
  expect(set.values()).toEqual([]);
  set.add('12345678');
  expect(set.values()).toEqual(['12345678']);
});

test('the set is bounded: the oldest value goes first, and a re-add moves a value to newest', () => {
  const set = new ScrubSet(3);
  set.add('value-aaa');
  set.add('value-bbb');
  set.add('value-ccc');
  set.add('value-aaa');
  expect(set.values()).toEqual(['value-bbb', 'value-ccc', 'value-aaa']);
  set.add('value-ddd');
  expect(set.values()).toEqual(['value-ccc', 'value-aaa', 'value-ddd']);
  expect(SCRUB_SET_LIMIT).toBe(4096);
  const big = new ScrubSet(SCRUB_SET_LIMIT, () => {});
  for (let i = 0; i <= SCRUB_SET_LIMIT; i++) big.add(`secret-value-${i}`);
  expect(big.values()).toHaveLength(SCRUB_SET_LIMIT);
  expect(big.values()[0]).toBe('secret-value-1');
});

test('one server-wide instance is exported', () => {
  expect(serverScrubSet).toBeInstanceOf(ScrubSet);
});

test('withBasicAuth is importable from @jumpmaster/protocol', async () => {
  const { withBasicAuth } = await import('@jumpmaster/protocol');
  expect(withBasicAuth(stateless)).toEqual([stateless, basic(stateless)]);
});

test('pinned PEM lines survive 5,000 later adds; the oldest tokens go; one warning at the first eviction', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const warnings: string[] = [];
  const set = new ScrubSet(SCRUB_SET_LIMIT, (l) => warnings.push(l));
  set.addPem(privateKey);
  const lines = privateKey.split('\n').filter((l) => l.length >= 40 && !l.startsWith('-----'));
  expect(lines.length).toBeGreaterThanOrEqual(20);
  const pinned = set.values().length;
  const token = (i: number) => `minted-value-${String(i).padStart(6, '0')}`;
  for (let i = 0; i < 5000; i++) set.add(token(i));

  const values = new Set(set.values());
  for (const l of lines) {
    expect(values.has(l)).toBe(true);
    expect(scrub(`x ${l} y`, undefined, [], set)).toBe('x [redacted] y');
  }
  expect(values.has(privateKey)).toBe(true);
  // Bounded: the evictable part holds `limit` values; pinned ones do not count.
  expect(set.values().length).toBe(pinned + SCRUB_SET_LIMIT);
  expect(values.has(token(0))).toBe(false);
  expect(values.has(token(4999))).toBe(true);
  expect(scrub(`x ${token(0)} y`, undefined, [], set)).toBe(`x ${token(0)} y`);
  // 904 evictions: only the first is said.
  expect(warnings).toEqual([EVICTION_WARNING]);
  expect(EVICTION_WARNING).toBe(
    'scrub set full: oldest minted values are no longer scrubbed by value',
  );
});

test('the eviction warning repeats every 1,000th eviction after the first', () => {
  const warnings: string[] = [];
  const set = new ScrubSet(10, (l) => warnings.push(l));
  for (let i = 0; i < 10 + 2001; i++) set.add(`value-${String(i).padStart(8, '0')}`);
  // Evictions 1, 1001 and 2001.
  expect(warnings).toEqual([EVICTION_WARNING, EVICTION_WARNING, EVICTION_WARNING]);
});

test('a pinned value is not evicted by a later add of the same value, nor counted', () => {
  const set = new ScrubSet(2, () => {});
  set.pin('vault-key-material');
  set.add('vault-key-material');
  set.add('token-one-xx');
  set.add('token-two-xx');
  set.add('token-three-x');
  expect(set.values()).toEqual(['vault-key-material', 'token-two-xx', 'token-three-x']);
  set.pin('short');
  expect(set.values()).not.toContain('short');
});

test('the server-wide set logs its eviction warning through the scrubbed server log', () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    lines.push(String(m));
  });
  try {
    for (let i = 0; i <= SCRUB_SET_LIMIT; i++) serverScrubSet.add(`server-value-${i}-padding`);
  } finally {
    spy.mockRestore();
    serverScrubSet.clear();
  }
  expect(lines).toEqual([`[jumpmaster] ${EVICTION_WARNING}`]);
});
