import { rootCertificates } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { type GitlabCaDeps, gitlabCaDigest, gitlabFetchFor } from './gitlab-ca.js';

// Two fake certificate blocks: gitlab-ca.ts only splits the bundle, it does not parse it.
const block = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
const CERT_A = block('QUFBQUFBQUFBQUFBQUFBQUFBQUFB');
const CERT_B = block('QkJCQkJCQkJCQkJCQkJCQkJCQkJC');
const BUNDLE = `${CERT_A}\n${CERT_B}\n`;

function fakeDeps() {
  const agents: { opts: { connect: { ca: string[]; rejectUnauthorized?: boolean } } }[] = [];
  const agentFactory = vi.fn((opts: { connect: { ca: string[] } }) => {
    const agent = { opts };
    agents.push(agent);
    return agent as never;
  });
  const fetch = vi.fn(async () => new Response('ok'));
  const deps: GitlabCaDeps = { agentFactory, fetch: fetch as never };
  return { deps, agents, agentFactory, fetch };
}

describe('gitlabFetchFor', () => {
  it('returns the global fetch when there is no CA', () => {
    expect(gitlabFetchFor(undefined)).toBe(globalThis.fetch);
    expect(gitlabFetchFor('')).toBe(globalThis.fetch);
    const { deps, agentFactory } = fakeDeps();
    expect(gitlabFetchFor(undefined, deps)).toBe(globalThis.fetch);
    expect(gitlabFetchFor('', deps)).toBe(globalThis.fetch);
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it('builds an agent whose connect.ca holds every system root and each zone certificate', () => {
    const { deps, agents } = fakeDeps();
    gitlabFetchFor(BUNDLE, deps);
    expect(agents).toHaveLength(1);
    const ca = agents[0]?.opts.connect.ca ?? [];
    for (const root of rootCertificates) expect(ca).toContain(root);
    expect(ca).toContain(CERT_A);
    expect(ca).toContain(CERT_B);
    expect(ca).toHaveLength(rootCertificates.length + 2);
  });

  it('never turns verification off', () => {
    const { deps, agents } = fakeDeps();
    gitlabFetchFor(BUNDLE, deps);
    expect(agents[0]?.opts.connect.rejectUnauthorized).not.toBe(false);
    expect(JSON.stringify(agents[0]?.opts)).not.toContain('"rejectUnauthorized":false');
  });

  it('calls the underlying fetch with the agent as dispatcher', async () => {
    const { deps, agents, fetch } = fakeDeps();
    const f = gitlabFetchFor(BUNDLE, deps);
    expect(f).not.toBe(globalThis.fetch);
    const res = await f('https://gitlab.example.com/api/v4/user', {
      method: 'GET',
      redirect: 'manual',
      headers: { 'PRIVATE-TOKEN': 'x' },
    });
    expect(await res.text()).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('https://gitlab.example.com/api/v4/user');
    expect(init.dispatcher).toBe(agents[0]);
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
  });

  it('reuses one agent for the same CA and builds a new one for another', () => {
    const { deps, agentFactory } = fakeDeps();
    const a1 = gitlabFetchFor(BUNDLE, deps);
    const a2 = gitlabFetchFor(BUNDLE, deps);
    expect(a2).toBe(a1);
    expect(agentFactory).toHaveBeenCalledTimes(1);
    const b = gitlabFetchFor(CERT_A, deps);
    expect(b).not.toBe(a1);
    expect(agentFactory).toHaveBeenCalledTimes(2);
  });

  it("a failing request's error holds no PEM text", async () => {
    const { deps } = fakeDeps();
    deps.fetch = (async () => {
      throw new TypeError(`fetch failed: ${BUNDLE}`, { cause: new Error(CERT_A) });
    }) as never;
    const f = gitlabFetchFor(BUNDLE, deps);
    const err = await f('https://gitlab.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const seen = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    const all = `${String(err)} ${(err as Error).stack} ${seen} ${String((err as Error).cause)}`;
    expect(all).not.toContain('BEGIN CERTIFICATE');
    expect(all).not.toContain('QUFBQUFB');
  });

  it('keeps an abort an abort', async () => {
    const { deps } = fakeDeps();
    deps.fetch = (async () => {
      throw new DOMException('aborted', 'TimeoutError');
    }) as never;
    const err = await gitlabFetchFor(
      BUNDLE,
      deps,
    )('https://gitlab.example.com/').catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('builds a real undici agent by default', () => {
    // A system root stands in for a zone CA: a real Agent is built, and nothing is sent.
    const f = gitlabFetchFor(rootCertificates[0] as string);
    expect(typeof f).toBe('function');
    expect(f).not.toBe(globalThis.fetch);
    expect(gitlabFetchFor(rootCertificates[0] as string)).toBe(f);
  });
});

describe('gitlabCaDigest', () => {
  it('is null without a CA and a short hex digest otherwise, never the PEM', () => {
    expect(gitlabCaDigest(undefined)).toBeNull();
    expect(gitlabCaDigest('')).toBeNull();
    const d = gitlabCaDigest(BUNDLE);
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(gitlabCaDigest(CERT_A)).not.toBe(d);
  });
});
