import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DropPayload, DropPayloadSchema, type GateResult } from '@jumpmaster/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyEgress, PROXY_ENV_KEYS, proxyEnv, writeToolProxyConfig } from './egress-env.js';
import { scrubEnv } from './gates.js';
import * as git from './git.js';
import { runTrooper, type TrooperDeps } from './main.js';

const URL_ = 'http://jm-egress:3128';
const ids = {
  agent: { uid: 10001, gid: 10001, home: '/home/agent' },
  gate: { uid: 10002, gid: 10002, home: '/home/gate' },
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  process.env = saved;
  git.setSpawn(null);
});

const base = {
  protocol: 1,
  dropId: 'd1',
  epoch: 1,
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 5, title: 't', body: 'b' },
  branch: 'agent/issue-5',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'review it',
  image: 'jumpmaster-trooper:test',
  protectedPaths: [],
  credentials: { claudeToken: 'sk-ant-oat-SECRETSECRETSECRET1234' },
  role: 'review',
  pr: { number: 9, branch: 'agent/issue-5', headSha: 'abc' },
  services: [
    { name: 'db', image: 'postgres:16', port: 5432 },
    { name: 'cache-1', image: 'redis:7', port: 6379 },
  ],
};
const withEgress = DropPayloadSchema.parse({
  ...base,
  egress: { mode: 'enforce', allow: ['api.anthropic.com', 'github.com'] },
});
const withoutEgress = DropPayloadSchema.parse(base);

/** Runs a review drop with fakes and records the environments the agent and the gates saw. */
async function runReview(payload: DropPayload) {
  const seen: { claude?: NodeJS.ProcessEnv; gates?: NodeJS.ProcessEnv } = {};
  const deps = {
    git: {
      cloneRepo: async () => {},
      checkoutBranch: async () => {},
      headSha: async () => 'abc',
      removeInstructionFiles: async () => [],
      treeState: async () => 'clean',
      sweepProcesses: () => false,
      cloneForGates: async () => {},
      removeTree: async () => {},
    } as unknown as TrooperDeps['git'],
    async *runClaude(_args: string[], env: NodeJS.ProcessEnv) {
      seen.claude = env;
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
      yield JSON.stringify({
        type: 'result',
        is_error: false,
        terminal_reason: 'completed',
        session_id: 's1',
        structured_output: { decision: 'approve', summary: 'ok', findings: [] },
      });
    },
    runGates: async (gates: { name: string }[], o: { env: NodeJS.ProcessEnv }) => {
      seen.gates = o.env;
      return gates.map(
        (g): GateResult => ({
          name: g.name,
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          outputTail: '',
        }),
      );
    },
    emit: () => {},
  } as unknown as TrooperDeps;
  // No sidecar listens here, so the drop runs without its services (their names are in NO_PROXY
  // through applyEgress, tested below).
  const result = await runTrooper({ ...payload, services: [] } as DropPayload, deps);
  return { seen, result };
}

describe('proxyEnv', () => {
  test('NO_PROXY lists localhost and every service name', () => {
    const env = proxyEnv(URL_, ['db', 'cache-1']);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,db,cache-1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
      expect(env[k], k).toBe(URL_);
    expect(env.JAVA_TOOL_OPTIONS).toBe(
      '-Dhttps.proxyHost=jm-egress -Dhttps.proxyPort=3128 -Dhttp.nonProxyHosts=localhost|127.0.0.1|db|cache-1',
    );
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(proxyEnv(URL_, []).NO_PROXY).toBe('localhost,127.0.0.1');
    expect(Object.keys(env).sort()).toEqual([...PROXY_ENV_KEYS].sort());
  });

  test('an image JAVA_TOOL_OPTIONS is kept, with the proxy properties appended', () => {
    const env = proxyEnv(URL_, [], { JAVA_TOOL_OPTIONS: '-Xmx2g' });
    expect(env.JAVA_TOOL_OPTIONS).toBe(
      '-Xmx2g -Dhttps.proxyHost=jm-egress -Dhttps.proxyPort=3128 -Dhttp.nonProxyHosts=localhost|127.0.0.1',
    );
  });

  test('scrubEnv keeps the proxy variables and still strips every JM_ variable', () => {
    const out = scrubEnv({
      ...proxyEnv(URL_, ['db']),
      JM_EGRESS_PROXY: URL_,
      JM_AGENT_UID: '10001',
      PATH: '/usr/bin',
    });
    for (const k of PROXY_ENV_KEYS) expect(out[k], k).toBeDefined();
    expect(Object.keys(out).filter((k) => k.startsWith('JM_'))).toEqual([]);
    expect(out.PATH).toBe('/usr/bin');
  });
});

describe('the trooper under egress', () => {
  test('payload.egress becomes proxy variables in the agent and gate environments', async () => {
    const { seen, result } = await runReview(withEgress);
    expect(result).toMatchObject({ status: 'completed' });
    for (const env of [seen.claude, seen.gates]) {
      expect(env?.HTTPS_PROXY).toBe(URL_);
      expect(env?.https_proxy).toBe(URL_);
      expect(env?.NO_PROXY).toBe('localhost,127.0.0.1');
      expect(env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(Object.keys(env ?? {}).filter((k) => k.startsWith('JM_'))).toEqual([]);
    }
  });

  test('without payload.egress no proxy variable or tool config is set', async () => {
    const { seen, result } = await runReview(withoutEgress);
    expect(result).toMatchObject({ status: 'completed' });
    for (const env of [seen.claude, seen.gates])
      for (const k of PROXY_ENV_KEYS) expect(env?.[k], k).toBeUndefined();
    const writes: string[] = [];
    await applyEgress(withoutEgress, ids, {
      env: {},
      write: async (home) => void writes.push(home),
    });
    expect(writes).toEqual([]);
  });

  test('with egress, the tool config goes into both homes before anything runs', async () => {
    const env: NodeJS.ProcessEnv = { JM_AGENT_UID: '10001' };
    const writes: [string, string, string, number | undefined][] = [];
    await applyEgress(withEgress, ids, {
      env,
      write: async (home, url, nonProxy, as) => void writes.push([home, url, nonProxy, as?.uid]),
    });
    expect(writes).toEqual([
      ['/home/agent', URL_, 'localhost|127.0.0.1|db|cache-1', 10001],
      ['/home/gate', URL_, 'localhost|127.0.0.1|db|cache-1', 10002],
    ]);
    expect(env.HTTPS_PROXY).toBe(URL_);
    // Outside the container (no identities) nothing is written into the real user's home.
    const none: string[] = [];
    await applyEgress(withEgress, null, { env: {}, write: async (h) => void none.push(h) });
    expect(none).toEqual([]);
  });

  test('a tool config that cannot be written fails the drop', async () => {
    for (const failing of ['/home/agent', '/home/gate']) {
      await expect(
        applyEgress(withEgress, ids, {
          env: {},
          write: async (home) => {
            if (home === failing) throw new Error(`disk full in ${home}`);
          },
        }),
      ).rejects.toThrow(`disk full in ${failing}`);
    }
  });

  test('a root git clone runs with https_proxy in its environment', async () => {
    await applyEgress(withEgress, null);
    const envs: NodeJS.ProcessEnv[] = [];
    git.setSpawn(((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      envs.push(opts.env ?? {});
      throw new Error('stop at the first git call');
    }) as never);
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'jm-egress-git-'));
    await expect(
      git.cloneRepo({ owner: 'o', name: 'r', token: 'ghp_x', dir: join(dir, 'repo') }),
    ).rejects.toThrow();
    expect(envs[0]?.https_proxy).toBe(URL_);
    expect(envs[0]?.HTTPS_PROXY).toBe(URL_);
    expect(envs[0]?.NO_PROXY).toBe('localhost,127.0.0.1,db,cache-1');
  });
});

describe('writeToolProxyConfig', () => {
  test('settings.xml and gradle.properties carry the proxy and are 0600, owned by each user', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jm-home-'));
    await writeToolProxyConfig(home, URL_, 'localhost|127.0.0.1|db', null);
    const xml = readFileSync(join(home, '.m2', 'settings.xml'), 'utf8');
    expect(xml).toContain('<host>jm-egress</host>');
    expect(xml).toContain('<port>3128</port>');
    expect(xml).toContain('<protocol>https</protocol>');
    expect(xml).toContain('<nonProxyHosts>localhost|127.0.0.1|db</nonProxyHosts>');
    const props = readFileSync(join(home, '.gradle', 'gradle.properties'), 'utf8');
    expect(props).toContain('systemProp.https.proxyHost=jm-egress\n');
    expect(props).toContain('systemProp.https.proxyPort=3128\n');
    expect(props).toContain('systemProp.https.nonProxyHosts=localhost|127.0.0.1|db\n');
    for (const f of [join(home, '.m2', 'settings.xml'), join(home, '.gradle', 'gradle.properties')])
      expect(statSync(f).mode & 0o777, f).toBe(0o600);
    for (const d of [join(home, '.m2'), join(home, '.gradle')])
      expect(statSync(d).mode & 0o077, d).toBe(0);

    // With an identity, the files are written by that uid (so it owns them), never by root.
    const argvs: string[][] = [];
    await writeToolProxyConfig('/home/gate', URL_, 'localhost', ids.gate, async (argv) => {
      argvs.push(argv);
    });
    expect(argvs[0]?.slice(0, 5)).toEqual([
      'setpriv',
      '--reuid=10002',
      '--regid=10002',
      '--clear-groups',
      '--',
    ]);
    const script = argvs[0]?.join(' ') ?? '';
    expect(script).toMatch(/umask 077/);
    expect(script).toMatch(/chmod 600/);
    expect(argvs[0]).toContain('/home/gate');
  });

  test('a host or port that could break the files is refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jm-home-'));
    await expect(
      writeToolProxyConfig(home, 'http://jm-egress:3128', 'a</nonProxyHosts><x>', null),
    ).rejects.toThrow(/non-proxy/);
    await expect(
      writeToolProxyConfig(home, 'http://a<b:3128', 'localhost', null),
    ).rejects.toThrow();
  });
});
