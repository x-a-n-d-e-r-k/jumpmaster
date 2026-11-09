// Egress, trooper side. Under egress the drop network has no route out: the only exit is the
// drop's proxy, which the trooper always finds at the fixed EGRESS_PROXY_URL. Its presence in the
// payload (never an environment variable, which scrubEnv would strip anyway) turns this on.
// The proxy variables go into process.env before anything is spawned, so every environment built
// from it (the agent's, the gates', root git's) carries them; tools that ignore them have no route.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DropPayload, EGRESS_PROXY_URL } from '@jumpmaster/protocol';
import { type AgentIdentity, asAgentArgv, type TrooperIdentities } from './privilege.js';

/** Every variable `proxyEnv` sets. */
export const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'JAVA_TOOL_OPTIONS',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'NODE_USE_ENV_PROXY',
] as const;

/** Hosts reached directly: loopback and the drop's services, by name on the drop network. */
function directHosts(serviceNames: string[]): string[] {
  return ['localhost', '127.0.0.1', ...serviceNames];
}

/**
 * The environment that routes tools through the proxy at `url`: the usual proxy variables (git's
 * libcurl, npm, pip, uv, Go, Gradle and Claude Code read them), Node's own fetch through
 * NODE_USE_ENV_PROXY, the JVM's proxy properties, and Claude Code's switches for traffic it
 * doesn't need. `base` supplies an image's own JAVA_TOOL_OPTIONS, which is kept.
 */
export function proxyEnv(
  url: string,
  serviceNames: string[],
  base: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const { hostname, port } = new URL(url);
  const direct = directHosts(serviceNames);
  const noProxy = direct.join(',');
  const java = `-Dhttps.proxyHost=${hostname} -Dhttps.proxyPort=${port} -Dhttp.nonProxyHosts=${direct.join('|')}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    JAVA_TOOL_OPTIONS:
      base.JAVA_TOOL_OPTIONS && !base.JAVA_TOOL_OPTIONS.includes(java)
        ? `${base.JAVA_TOOL_OPTIONS} ${java}`
        : java,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NODE_USE_ENV_PROXY: '1',
  };
}

const SAFE_HOST = /^[a-z0-9.-]+$/;
const SAFE_NON_PROXY = /^[A-Za-z0-9.|*-]+$/;

function mavenSettings(host: string, port: string, nonProxy: string): string {
  // Two entries: Maven picks a proxy by the repository URL's protocol, and both go through the
  // one HTTP CONNECT proxy (plain HTTP is refused there with 405).
  const proxy = (id: string, protocol: string) =>
    `    <proxy>\n      <id>${id}</id>\n      <active>true</active>\n      <protocol>${protocol}</protocol>\n      <host>${host}</host>\n      <port>${port}</port>\n      <nonProxyHosts>${nonProxy}</nonProxyHosts>\n    </proxy>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Written by the Jumpmaster trooper: this drop's only route out is its egress proxy. -->\n<settings>\n  <proxies>\n${proxy('jm-egress-https', 'https')}${proxy('jm-egress-http', 'http')}  </proxies>\n</settings>\n`;
}

function gradleProperties(host: string, port: string, nonProxy: string): string {
  return [
    "# Written by the Jumpmaster trooper: this drop's only route out is its egress proxy.",
    `systemProp.https.proxyHost=${host}`,
    `systemProp.https.proxyPort=${port}`,
    `systemProp.https.nonProxyHosts=${nonProxy}`,
    `systemProp.http.nonProxyHosts=${nonProxy}`,
    '',
  ].join('\n');
}

const WRITE_AS_USER =
  'umask 077 && mkdir -p "$1/.m2" "$1/.gradle" && printf %s "$2" > "$1/.m2/settings.xml" && printf %s "$3" > "$1/.gradle/gradle.properties" && chmod 600 "$1/.m2/settings.xml" "$1/.gradle/gradle.properties"';

function runToEnd(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv as [string, ...string[]];
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`writing proxy config failed (exit ${code})`)),
    );
  });
}

/**
 * Maven ignores the JVM proxy properties, so it gets `~/.m2/settings.xml` with a proxy stanza;
 * Gradle gets `~/.gradle/gradle.properties`. Both mode 0600. With an identity the files are
 * written by that uid, so it owns them (the trooper's root has no CHOWN and can't enter the home).
 */
export async function writeToolProxyConfig(
  home: string,
  url: string,
  nonProxy: string,
  as: AgentIdentity | null,
  run: (argv: string[]) => Promise<void> = runToEnd,
): Promise<void> {
  const { hostname, port } = new URL(url);
  if (!SAFE_HOST.test(hostname) || !/^\d+$/.test(port))
    throw new Error(`proxy URL ${url} has an unexpected host or port`);
  if (!SAFE_NON_PROXY.test(nonProxy)) throw new Error(`unexpected non-proxy hosts: ${nonProxy}`);
  const xml = mavenSettings(hostname, port, nonProxy);
  const props = gradleProperties(hostname, port, nonProxy);
  if (as) {
    await run(asAgentArgv(as, ['sh', '-c', WRITE_AS_USER, 'jm-proxy-config', home, xml, props]));
    return;
  }
  for (const [dir, file, text] of [
    ['.m2', 'settings.xml', xml],
    ['.gradle', 'gradle.properties', props],
  ] as const) {
    mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
    chmodSync(join(home, dir), 0o700);
    writeFileSync(join(home, dir, file), text, { mode: 0o600 });
    chmodSync(join(home, dir, file), 0o600);
  }
}

/**
 * Turns on the proxy for this drop when the payload carries `egress`: sets the proxy variables in
 * `env` (process.env) and, in container mode, writes the Maven and Gradle files into the agent's
 * and the gate's homes. Runs before anything is spawned. Without `egress` it changes nothing.
 */
export async function applyEgress(
  payload: DropPayload,
  ids: TrooperIdentities | null,
  o: { env?: NodeJS.ProcessEnv; write?: typeof writeToolProxyConfig } = {},
): Promise<void> {
  if (!payload.egress) return;
  const env = o.env ?? process.env;
  const services = ('services' in payload ? payload.services : undefined) ?? [];
  const names = services.map((s) => s.name);
  Object.assign(env, proxyEnv(EGRESS_PROXY_URL, names, env));
  if (!ids) return;
  const write = o.write ?? writeToolProxyConfig;
  const nonProxy = directHosts(names).join('|');
  await write(ids.agent.home, EGRESS_PROXY_URL, nonProxy, ids.agent);
  await write(ids.gate.home, EGRESS_PROXY_URL, nonProxy, ids.gate);
}
