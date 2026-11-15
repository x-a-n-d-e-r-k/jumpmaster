import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from 'vitest';
import { scrub } from '../scrub.js';
import { SCRUB_SET_LIMIT, ScrubSet, serverScrubSet } from './scrub-set.js';

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
  const big = new ScrubSet();
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
