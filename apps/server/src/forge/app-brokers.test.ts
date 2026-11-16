import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { createAppBrokers } from './app-brokers.js';
import { serverScrubSet } from './scrub-set.js';

const pem = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
const KEY_A = pem();
const KEY_B = pem();

const entry = (key: string, fingerprint: string): AppEntryRead => ({
  source: 'vault',
  fingerprint,
  entry: { appId: '42', slug: 'jm', clientId: 'c', pem: key, importedAt: '2026-11-01' },
});
const missing: AppEntryRead = { source: 'missing' };

function appsOf(o: Record<string, Partial<Record<AppRole, AppEntryRead>>>): ResolvedApps {
  return new Map(
    Object.entries(o).map(([owner, r]) => [
      owner,
      { author: r.author ?? missing, reviewer: r.reviewer ?? missing },
    ]),
  );
}

afterEach(() => serverScrubSet.clear());

describe('createAppBrokers', () => {
  test('is memoized per owner and role', () => {
    const apps = appsOf({
      octo: { author: entry(KEY_A, 'fa'), reviewer: entry(KEY_A, 'fr') },
      other: { author: entry(KEY_A, 'fo') },
    });
    const b = createAppBrokers({ apps: () => apps, onSecret: () => {} });
    const author = b.brokerFor('octo', 'author');
    expect(author).toBeDefined();
    expect(b.brokerFor('octo', 'author')).toBe(author);
    expect(b.brokerFor('octo', 'reviewer')).not.toBe(author);
    expect(b.brokerFor('other', 'author')).not.toBe(author);
  });

  test('is rebuilt when the entry fingerprint changes', () => {
    let apps = appsOf({ octo: { author: entry(KEY_A, 'one') } });
    const b = createAppBrokers({ apps: () => apps, onSecret: () => {} });
    const first = b.brokerFor('octo', 'author');
    apps = appsOf({ octo: { author: entry(KEY_B, 'two') } });
    const second = b.brokerFor('octo', 'author');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(b.brokerFor('octo', 'author')).toBe(second);
  });

  test('returns undefined for a missing owner, a missing entry and an undecryptable one', () => {
    const apps = appsOf({ octo: { author: { source: 'missing', undecryptable: true } } });
    const b = createAppBrokers({ apps: () => apps, onSecret: () => {} });
    expect(b.brokerFor('nobody', 'author')).toBeUndefined();
    expect(b.brokerFor('octo', 'reviewer')).toBeUndefined();
    expect(b.brokerFor('octo', 'author')).toBeUndefined();
  });

  test('registers the PEM with the server scrub set by default', () => {
    const apps = appsOf({ octo: { author: entry(KEY_A, 'fa') } });
    const b = createAppBrokers({ apps: () => apps });
    b.brokerFor('octo', 'author');
    expect(serverScrubSet.values()).toContain(KEY_A);
    const body = KEY_A.split('\n')
      .filter((l) => l && !l.startsWith('-----'))
      .join('');
    expect(serverScrubSet.values()).toContain(body);
  });

  test('hands the PEM to a given onSecret', () => {
    const seen: string[] = [];
    const apps = appsOf({ octo: { author: entry(KEY_A, 'fa') } });
    createAppBrokers({ apps: () => apps, onSecret: (s) => seen.push(s) }).brokerFor(
      'octo',
      'author',
    );
    expect(seen).toContain(KEY_A);
  });
});
