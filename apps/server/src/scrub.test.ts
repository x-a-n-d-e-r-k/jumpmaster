import { afterEach, expect, test } from 'vitest';
import type { Config } from './config.js';
import { secretList } from './config.js';
import { ScrubSet, serverScrubSet } from './forge/scrub-set.js';
import { redactionList, scrub } from './scrub.js';

const config = (secrets: Record<string, unknown>) => ({ secrets }) as unknown as Config;

/** The implementation this module replaced, kept to pin its behaviour. */
function previous(msg: string, config: Config | undefined, retired: readonly string[] = []) {
  if (!config) return msg;
  return [...secretList(config.secrets), ...retired].reduce(
    (m, s) => m.split(s).join('[redacted]'),
    msg,
  );
}

afterEach(() => serverScrubSet.clear());

test('a registered token is redacted by the default scrub, with and without a config', () => {
  serverScrubSet.add('ghs_registered_token_value');
  const msg = 'push failed with ghs_registered_token_value';
  expect(scrub(msg, undefined)).toBe('push failed with [redacted]');
  expect(scrub(msg, config({ claudeToken: 'claude-token-value' }), [])).toBe(
    'push failed with [redacted]',
  );
});

test('with an empty set, the output matches the previous implementation', () => {
  const cases: [string, Config | undefined, string[]][] = [
    ['nothing secret here', undefined, []],
    ['claude-token-value in text', undefined, ['old-value-1']],
    [
      'claude-token-value and author-token-value',
      config({
        claudeToken: 'claude-token-value',
        authorToken: 'author-token-value',
        operatorToken: '',
      }),
      [],
    ],
    [
      'a old-retired-value b zone-secret-1 c',
      config({
        claudeToken: 'claude-token-value',
        zoneSecrets: { z1: { GATE: 'zone-secret-1' } },
      }),
      ['old-retired-value'],
    ],
    ['repeated x-secret-x x-secret-x', config({ joinToken: 'x-secret-x' }), []],
    ['', config({ joinToken: 'join-token-value' }), ['retired-value']],
  ];
  const empty = new ScrubSet();
  for (const [msg, c, retired] of cases) {
    expect(scrub(msg, c, retired, empty)).toBe(previous(msg, c, retired));
  }
});

test('a configured secret that contains another is redacted whole', () => {
  const c = config({ claudeToken: 'inner-secret', authorToken: 'outer-inner-secret-tail' });
  expect(scrub('x outer-inner-secret-tail y', c, [], new ScrubSet())).toBe('x [redacted] y');
});

const ghp = `${'ghp_'}${'A'.repeat(36)}`;

test('an unregistered token-shaped string is replaced, with nothing registered', () => {
  expect(scrub(`x ${ghp}`, undefined)).toBe('x [redacted]');
  expect(scrub(`x ${ghp}`, config({}))).toBe('x [redacted]');
});

test('an unregistered token and a registered literal in one line are both replaced (D4 forms)', () => {
  const set = new ScrubSet(16, () => {});
  set.add('registered-literal-value');
  const b64 = Buffer.from(`x-access-token:${ghp}`).toString('base64');
  const cases: [string, string][] = [
    [`${ghp} and registered-literal-value`, '[redacted] and [redacted]'],
    // JSON-escaped: the token right after an escaped newline.
    [JSON.stringify(`line\n${ghp}\nregistered-literal-value`), '"line\\n[redacted]\\n[redacted]"'],
    // Git's basic-auth form of an unregistered token.
    [
      `Authorization: Basic ${b64} registered-literal-value`,
      'Authorization: Basic [redacted] [redacted]',
    ],
  ];
  for (const [msg, want] of cases) expect(scrub(msg, undefined, [], set)).toBe(want);
});

test('redactionList holds the configured secrets and every scrub-set value', () => {
  const set = new ScrubSet(16, () => {});
  set.add('minted-only-value');
  set.pin('pinned-only-value');
  expect(redactionList(config({ claudeToken: 'claude-token-value' }).secrets, set)).toEqual([
    'claude-token-value',
    'pinned-only-value',
    'minted-only-value',
  ]);
});
