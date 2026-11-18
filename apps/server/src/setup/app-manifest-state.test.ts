import { describe, expect, it } from 'vitest';
import {
  AppManifestStore,
  MAX_PENDINGS,
  MAX_STATES,
  type PendingApp,
  STATE_TTL_MS,
} from './app-manifest-state.js';

const MIN = 60_000;
const PEM_BODY = 'MIIEowIBAAKCAQEAsecretpemfixturebodyXYZ0123456789';
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`;

function setup() {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const store = new AppManifestStore({ now: clock.now });
  return { store, clock };
}

const app = (over: Partial<PendingApp> = {}): PendingApp => ({
  appId: '123',
  slug: 'acme-jumpmaster-author',
  clientId: 'Iv1.abc',
  pem: PEM,
  owner: 'acme',
  role: 'author',
  ...over,
});

describe('manifest state', () => {
  it('mints a 32-byte base64url state, consumed once with the owner lowercased', () => {
    const { store } = setup();
    const state = store.mintState({ sessionId: 's1', owner: 'Acme', role: 'author' });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consumeState(state)).toEqual({ sessionId: 's1', owner: 'acme', role: 'author' });
    expect(store.consumeState(state)).toBeUndefined();
  });

  it('uses the injected random source', () => {
    const store = new AppManifestStore({ randomBytes: (n) => Buffer.alloc(n, 7) });
    expect(store.mintState({ sessionId: 's', owner: 'a', role: 'author' })).toBe(
      Buffer.alloc(32, 7).toString('base64url'),
    );
  });

  it('expires ten minutes after minting', () => {
    const { store, clock } = setup();
    const a = store.mintState({ sessionId: 's', owner: 'acme', role: 'reviewer' });
    const b = store.mintState({ sessionId: 's', owner: 'acme', role: 'reviewer' });
    clock.advance(9 * MIN + 59_000);
    expect(store.consumeState(a)).toEqual({ sessionId: 's', owner: 'acme', role: 'reviewer' });
    clock.advance(2_000);
    expect(store.consumeState(b)).toBeUndefined();
    expect(STATE_TTL_MS).toBe(10 * MIN);
  });

  it('gives undefined for unknown or non-string states without throwing', () => {
    const { store } = setup();
    store.mintState({ sessionId: 's', owner: 'acme', role: 'author' });
    expect(store.consumeState('nope')).toBeUndefined();
    expect(store.consumeState('')).toBeUndefined();
    expect(store.consumeState(undefined)).toBeUndefined();
    expect(store.consumeState(42)).toBeUndefined();
    expect(store.consumeState({})).toBeUndefined();
  });

  it('refuses an invalid owner or role without echoing it', () => {
    const { store } = setup();
    expect(() => store.mintState({ sessionId: 's', owner: 'a/b', role: 'author' })).toThrow();
    try {
      store.mintState({ sessionId: 's', owner: 'a/b', role: 'author' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('a/b');
    }
    try {
      store.mintState({ sessionId: 's', owner: 'acme', role: 'admin' as never });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('admin');
    }
  });

  it('refuses the 65th unexpired state and mints again once they expire', () => {
    const { store, clock } = setup();
    expect(MAX_STATES).toBe(64);
    for (let i = 0; i < 64; i++) store.mintState({ sessionId: 's', owner: 'acme', role: 'author' });
    expect(() => store.mintState({ sessionId: 's', owner: 'acme', role: 'author' })).toThrow();
    clock.advance(10 * MIN + 1_000);
    expect(store.mintState({ sessionId: 's', owner: 'acme', role: 'author' })).toBeTypeOf('string');
  });
});

describe('pending apps', () => {
  it('is claimed once, only by its own session', () => {
    const { store } = setup();
    const id = store.putPending('s1', app());
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.claimPending(id, 's2')).toBeUndefined();
    expect(store.claimPending(id, 's1')).toEqual(app());
    expect(store.claimPending(id, 's1')).toBeUndefined();
    expect(store.claimPending('unknown', 's1')).toBeUndefined();
    expect(store.claimPending(undefined, 's1')).toBeUndefined();
  });

  it('reports an expired pending to exactly one sweep, even after a late claim', () => {
    const { store, clock } = setup();
    const id = store.putPending('s1', app({ owner: 'acme', role: 'reviewer', slug: 'acme-rev' }));
    clock.advance(9 * MIN + 59_000);
    expect(store.sweep()).toEqual([]);
    clock.advance(2_000);
    expect(store.claimPending(id, 's1')).toBeUndefined();
    const report = store.sweep();
    expect(report).toEqual([{ owner: 'acme', role: 'reviewer', slug: 'acme-rev' }]);
    expect(report[0]).not.toHaveProperty('pem');
    expect(store.sweep()).toEqual([]);
  });

  it('sweep drops expired states too', () => {
    const { store, clock } = setup();
    const s = store.mintState({ sessionId: 's', owner: 'acme', role: 'author' });
    clock.advance(10 * MIN + 1_000);
    store.sweep();
    expect(store.consumeState(s)).toBeUndefined();
  });

  it('refuses the 17th unexpired pending; puts again only after sweep', () => {
    const { store, clock } = setup();
    expect(MAX_PENDINGS).toBe(16);
    for (let i = 0; i < 16; i++) store.putPending('s', app());
    expect(() => store.putPending('s', app())).toThrow();
    clock.advance(10 * MIN + 1_000);
    expect(store.sweep()).toHaveLength(16);
    expect(store.putPending('s', app())).toBeTypeOf('string');
  });

  it('does not let expired pendings block a put, nor drop them', () => {
    const { store, clock } = setup();
    for (let i = 0; i < 16; i++) store.putPending('s', app());
    clock.advance(10 * MIN + 1_000);
    expect(store.putPending('s', app())).toBeTypeOf('string');
    expect(store.sweep()).toHaveLength(16);
  });
});

describe('no leaks', () => {
  it('keeps PEMs and states out of serialisations and errors', () => {
    const { store } = setup();
    const state = store.mintState({ sessionId: 's', owner: 'acme', role: 'author' });
    store.putPending('s', app());
    const messages: string[] = [];
    const capture = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        messages.push(String(e), (e as Error).message, JSON.stringify(e));
      }
    };
    for (let i = 0; i < 70; i++)
      capture(() => store.mintState({ sessionId: 's', owner: 'acme', role: 'author' }));
    for (let i = 0; i < 20; i++) capture(() => store.putPending('s', app()));
    capture(() => store.mintState({ sessionId: 's', owner: state, role: 'author' }));
    capture(() => store.mintState({ sessionId: 's', owner: 'acme', role: PEM as never }));
    expect(messages.length).toBeGreaterThan(0);
    const outputs = [JSON.stringify(store), String(store), `${store}`, ...messages];
    for (const out of outputs) {
      expect(out).not.toContain('BEGIN');
      expect(out).not.toContain(PEM_BODY);
      expect(out).not.toContain(state);
    }
  });
});
