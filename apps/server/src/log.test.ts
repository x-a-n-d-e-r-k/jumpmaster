import { afterEach, expect, test, vi } from 'vitest';
import type { Config } from './config.js';
import { serverScrubSet } from './forge/scrub-set.js';
import { log, setLogSource } from './log.js';

afterEach(() => {
  serverScrubSet.clear();
  vi.restoreAllMocks();
});

const capture = () => {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    lines.push(String(m));
  });
  return lines;
};

const config = { secrets: { claudeToken: 'configured-secret-value' } } as unknown as Config;

test('log scrubs the source config, the retired values, the scrub set and token shapes', () => {
  const lines = capture();
  const undo = setLogSource({ current: () => config, retired: () => ['retired-secret-value'] });
  serverScrubSet.add('minted-scrub-set-value');
  const ghp = `${'ghp_'}${'C'.repeat(36)}`;
  log(`a configured-secret-value b retired-secret-value c minted-scrub-set-value d ${ghp}`);
  undo();
  // With the source unset, the scrub set and the shapes still apply.
  log('configured-secret-value minted-scrub-set-value');
  expect(lines).toEqual([
    '[jumpmaster] a [redacted] b [redacted] c [redacted] d [redacted]',
    '[jumpmaster] configured-secret-value [redacted]',
  ]);
});

test("an undo does not clear a later server's source", () => {
  const lines = capture();
  const first = setLogSource({ current: () => config, retired: () => [] });
  const second = setLogSource({ current: () => config, retired: () => [] });
  first();
  log('configured-secret-value');
  second();
  log('configured-secret-value');
  expect(lines).toEqual(['[jumpmaster] [redacted]', '[jumpmaster] configured-secret-value']);
});
