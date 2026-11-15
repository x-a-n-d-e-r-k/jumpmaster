import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTokenCache, type TokenKey } from './token-cache.js';

// Fixture tokens are split after the prefix so no tracked line is token-shaped.
const fakeToken = (n: number) => 'ghs_' + `FAKE_TOKEN_${String(n).padStart(4, '0')}`;

const MIN = 60_000;
const T0 = 1_790_000_000_000;

const AUTHOR: TokenKey = { owner: 'acme', role: 'author', repositoryId: 1 };
const REVIEWER: TokenKey = { owner: 'acme', role: 'reviewer', repositoryId: 1 };

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
const captured: string[] = [];
const minted: string[] = [];

beforeAll(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  }
});

afterAll(() => {
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  for (const msg of captured) {
    for (const t of minted) expect(msg).not.toContain(t);
  }
  for (const s of consoleSpies) s.mockRestore();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A harness with a fake clock, a counting mint and a recording register. */
function harness(lifetimeMs = 60 * MIN) {
  let clock = T0;
  let n = 0;
  const registered: string[] = [];
  const mint = vi.fn(async (_key: TokenKey) => {
    n += 1;
    const token = fakeToken(n);
    minted.push(token);
    return { token, expiresAt: new Date(clock + lifetimeMs) };
  });
  const register = vi.fn((t: string) => {
    registered.push(t);
  });
  const cache = createTokenCache({ mint, register, now: () => clock });
  return {
    cache,
    mint,
    register,
    registered,
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    captured.push((err as Error).message);
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('createTokenCache', () => {
  test('cold cache mints once and registers before returning; a warm call reuses', async () => {
    const h = harness();
    let registeredAtResolve: string[] = [];
    const t1 = await h.cache.token(AUTHOR).then((t) => {
      registeredAtResolve = [...h.registered];
      return t;
    });
    expect(t1).toBe(fakeToken(1));
    expect(registeredAtResolve).toEqual([fakeToken(1)]);
    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(h.mint).toHaveBeenCalledWith(AUTHOR);

    h.setClock(T0 + 30 * MIN); // 30 minutes left
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(1));
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  test('exactly ten minutes left does not re-mint; 9 min 59 s left does', async () => {
    const h = harness();
    await h.cache.token(AUTHOR);
    h.setClock(T0 + 50 * MIN);
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(1));
    expect(h.mint).toHaveBeenCalledTimes(1);

    h.setClock(T0 + 50 * MIN + 1000);
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(2));
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.registered).toEqual([fakeToken(1), fakeToken(2)]);
  });

  test('an expired token re-mints', async () => {
    const h = harness();
    await h.cache.token(AUTHOR);
    h.setClock(T0 + 61 * MIN);
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(2));
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  test('ten concurrent calls on a cold cache share one mint', async () => {
    const h = harness();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => h.cache.token(AUTHOR)));
    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set([fakeToken(1)]));
  });

  test('ten concurrent calls on a rejecting mint all reject; the next call mints again', async () => {
    const h = harness();
    h.mint.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const calls = Array.from({ length: 10 }, () => h.cache.token(AUTHOR));
    const errors = await Promise.all(calls.map(rejection));
    expect(errors).toHaveLength(10);
    expect(h.mint).toHaveBeenCalledTimes(1);

    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(1));
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  test('a register that throws rejects, caches nothing, and the next call mints again', async () => {
    const h = harness();
    h.register.mockImplementationOnce(() => {
      throw new Error('register failed');
    });
    const calls = [h.cache.token(AUTHOR), h.cache.token(AUTHOR)];
    const errors = await Promise.all(calls.map(rejection));
    for (const e of errors) {
      expect(e.message).toBe('could not mint the author installation token for acme');
      expect(e.message).not.toContain(fakeToken(1));
    }
    expect(h.mint).toHaveBeenCalledTimes(1);

    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(2));
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  test('separate keys mint and cache separately', async () => {
    const h = harness();
    const keys: TokenKey[] = [
      AUTHOR,
      REVIEWER,
      { owner: 'other', role: 'author', repositoryId: 1 },
      { owner: 'acme', role: 'author', repositoryId: 2 },
    ];
    const first = await Promise.all(keys.map((k) => h.cache.token(k)));
    expect(new Set(first).size).toBe(4);
    expect(h.mint).toHaveBeenCalledTimes(4);
    for (const [i, k] of keys.entries()) expect(h.mint).toHaveBeenNthCalledWith(i + 1, k);

    const again = await Promise.all(keys.map((k) => h.cache.token({ ...k })));
    expect(again).toEqual(first);
    expect(h.mint).toHaveBeenCalledTimes(4);
  });

  test('the error does not copy the mint error message, which may hold a token', async () => {
    const h = harness();
    const leaked = fakeToken(9999);
    minted.push(leaked);
    const cause = new Error(`bad credentials for ${leaked}`);
    h.mint.mockImplementationOnce(async () => {
      throw cause;
    });
    const err = await rejection(h.cache.token(REVIEWER));
    expect(err.message).toBe('could not mint the reviewer installation token for acme');
    expect(err.message).not.toContain(leaked);
    expect(err.cause).toBe(cause);

    expect(await h.cache.token(REVIEWER)).toBe(fakeToken(1));
  });

  test('invalidate re-mints that key only; clear re-mints every key', async () => {
    const h = harness();
    await h.cache.token(AUTHOR);
    await h.cache.token(REVIEWER);

    h.cache.invalidate({ ...AUTHOR });
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(3));
    expect(await h.cache.token(REVIEWER)).toBe(fakeToken(2));
    expect(h.mint).toHaveBeenCalledTimes(3);

    h.cache.clear();
    expect(await h.cache.token(AUTHOR)).toBe(fakeToken(4));
    expect(await h.cache.token(REVIEWER)).toBe(fakeToken(5));
    expect(h.mint).toHaveBeenCalledTimes(5);
  });

  for (const [name, drop] of [
    ['clear', (c: ReturnType<typeof createTokenCache>) => c.clear()],
    ['invalidate', (c: ReturnType<typeof createTokenCache>) => c.invalidate(AUTHOR)],
  ] as const) {
    test(`a mint in progress across ${name} is registered but never cached`, async () => {
      const h = harness();
      const held = deferred<{ token: string; expiresAt: Date }>();
      h.mint.mockImplementationOnce(() => held.promise);

      const waiting = h.cache.token(AUTHOR);
      drop(h.cache);
      const after = h.cache.token(AUTHOR);
      expect(h.mint).toHaveBeenCalledTimes(2);

      const stale = 'ghs_' + 'FAKE_STALE_0001';
      minted.push(stale);
      held.resolve({ token: stale, expiresAt: new Date(T0 + 60 * MIN) });
      expect(await waiting).toBe(stale);
      expect(h.registered).toContain(stale);

      const fresh = await after;
      expect(fresh).not.toBe(stale);
      expect(fresh).toBe(fakeToken(1));

      // The stale token is not cached either: the cache holds the fresh one.
      expect(await h.cache.token(AUTHOR)).toBe(fresh);
      expect(h.mint).toHaveBeenCalledTimes(2);
    });
  }

  test('a stale mint finishing after clear does not displace a later mint', async () => {
    const h = harness();
    const held = deferred<{ token: string; expiresAt: Date }>();
    h.mint.mockImplementationOnce(() => held.promise);
    const waiting = h.cache.token(AUTHOR);
    h.cache.clear();
    const fresh = await h.cache.token(AUTHOR);

    const stale = 'ghs_' + 'FAKE_STALE_0002';
    minted.push(stale);
    held.resolve({ token: stale, expiresAt: new Date(T0 + 60 * MIN) });
    await waiting;
    expect(await h.cache.token(AUTHOR)).toBe(fresh);
  });

  test('the module source names no forbidden permission, I/O or logging', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./token-cache.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/administration|workflows/);
    expect(src).not.toMatch(/\bconsole\b|\bfetch\b|\blogger\b|node:fs|undici|vault/i);
    expect(src).not.toMatch(/^import /m);
  });
});
