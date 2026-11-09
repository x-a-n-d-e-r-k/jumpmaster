// Egress e2e driver. Runs inside the stick image (egress.sh mounts it) and drives the stick's own
// runDrop and DockerDriver against the real engine, with a fake server client. While each drop's
// trooper is about to start (network, proxy and services up), it probes from outside: a service's
// DNS and routes, and the proxy from the shared exit network. Prints one line per check and exits
// non-zero on any failure. Args: E2E_REPO, E2E_BRANCH, E2E_SHA come from the environment.
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/stick/dist/main.js');
const Docker = require('dockerode');
const { DockerDriver } = await import('/app/apps/stick/dist/docker.js');
const { runDrop } = await import('/app/apps/stick/dist/runner.js');
const { egressCapability } = await import('/app/apps/stick/dist/egress.js');

const env = process.env;
const [owner, name] = (env.E2E_REPO ?? '').split('/');
const TROOPER = 'jumpmaster-trooper:e2e';
const SERVICE = 'jumpmaster-e2e-service:dev';
const ALPINE = env.E2E_ALPINE;
const docker = new Docker();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'ok' : 'FAIL'}: ${label}${ok || detail === '' ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`,
  );
  if (!ok) failures++;
};

/** Runs a command in a container; resolves with its exit code and output. */
async function exec(container, cmd) {
  const e = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await e.start({ hijack: true, stdin: false });
  let out = '';
  const sink = { write: (c) => void (out += c.toString('utf8')) };
  docker.modem.demuxStream(stream, sink, sink);
  await new Promise((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  const { ExitCode } = await e.inspect();
  return { code: ExitCode, out: out.trim() };
}

/** Runs a throwaway alpine container on `network` and returns its exit code and output. */
async function runOn(network, script) {
  const c = await docker.createContainer({
    Image: ALPINE,
    Cmd: ['sh', '-c', script],
    HostConfig: { NetworkMode: network, AutoRemove: false },
  });
  await c.start();
  const { StatusCode } = await c.wait();
  // Not a TTY: the logs are multiplexed; keep the payload of each frame.
  const raw = await c.logs({ stdout: true, stderr: true });
  let out = '';
  for (let i = 0; i + 8 <= raw.length; ) {
    const len = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  await c.remove({ force: true });
  return { code: StatusCode, out: out.trim() };
}

const byLabels = async (labels) => docker.listContainers({ all: true, filters: { label: labels } });

/** The stick's driver, with checks from outside the drop just before the trooper starts. */
class ProbingDriver extends DockerDriver {
  started = [];
  async start(o) {
    this.started.push(o.name);
    if (o.egress && this.probe) await this.probe(o);
    return super.start(o);
  }
}

function payload(dropId, mode, allow) {
  return {
    protocol: 1,
    dropId,
    epoch: 1,
    role: 'review',
    repo: { owner, name, defaultBranch: env.E2E_BRANCH },
    issue: { number: 1, title: 'e2e', body: 'e2e' },
    branch: env.E2E_BRANCH,
    pr: { number: 1, branch: env.E2E_BRANCH, headSha: env.E2E_SHA },
    // Not gate secrets: those values are redacted from the output, and `enforce` would be.
    gates: [
      {
        name: 'egress',
        run: `E2E_MODE=${mode} E2E_HOST_PORT=${env.E2E_HOST_PORT ?? '39999'} node /usr/local/lib/jm-e2e/egress-probe.js`,
        timeoutMinutes: 5,
      },
    ],
    model: 'm',
    maxTurns: 1,
    promptVersion: 'e2e',
    prompt: 'review',
    image: TROOPER,
    protectedPaths: [],
    credentials: { claudeToken: 'sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY' },
    services: [{ name: 'db', image: SERVICE, port: 5432, readyTimeoutSeconds: 30 }],
    egress: { mode, allow },
  };
}

function client() {
  return {
    events: [],
    result: undefined,
    async heartbeat() {
      return 'ok';
    },
    async postEvents(_d, _e, ev) {
      this.events.push(...ev);
      return 'ok';
    },
    async postResult(_d, _e, r) {
      this.result = r;
      return 'ok';
    },
    async postArtifact() {
      return 'ok';
    },
  };
}

async function drop(dropId, mode, allow, o = {}) {
  const driver = new ProbingDriver(docker);
  driver.probe = o.probe;
  const c = client();
  const started = Date.now();
  await runDrop(payload(dropId, mode, allow), {
    client: c,
    driver,
    stickId: 'e2e-stick',
    allowedImages: new Set([TROOPER, SERVICE]),
    egressImage: o.egressImage ?? 'jumpmaster-egress:dev',
    heartbeatMs: 60_000,
  });
  const left = await byLabels([`jumpmaster.drop=${dropId}`]);
  const nets = await docker.listNetworks({ filters: { label: [`jumpmaster.drop=${dropId}`] } });
  check(
    `${dropId}: teardown left no container or network`,
    left.length === 0 && nets.length === 0,
    {
      left: left.map((x) => x.Names),
      nets: nets.map((n) => n.Name),
    },
  );
  return { result: c.result, events: c.events, started: driver.started, ms: Date.now() - started };
}

const egressOf = (events) =>
  new Map(
    events
      .filter((e) => e.kind === 'egress')
      .map((e) => [`${e.data.decision} ${e.data.host}`, e.data.count]),
  );

// 0. The stick can enforce egress on this engine, so it would advertise egress-v1.
const cap = await egressCapability(new DockerDriver(docker), env);
check('stick: egressCapability passes on this engine (egress-v1 advertised)', cap.ok, cap);

// 0b. The capability probe is behavioural: on a drop network it finds the gateway closed, and on
// a network that leaves the host an address at its gateway (no inhibit_ipv4) it finds it open, so
// an engine that ignored the option would not get egress-v1.
{
  const { allocateSubnet, dropLayout } = await import('/app/apps/stick/dist/subnets.js');
  const d = new DockerDriver(docker);
  const probeLabels = {
    'jumpmaster.stick': 'e2e-stick',
    'jumpmaster.drop': 'e2e-probe',
    'jumpmaster.epoch': '1',
  };
  const good = await d.createDropNetwork('jm-e2e-probe-good', probeLabels, '172.30.0.0/16');
  const held = (await docker.listNetworks()).flatMap((n) =>
    (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter(Boolean),
  );
  const open = dropLayout('jm-e2e-probe-open', allocateSubnet(held, '172.30.0.0/16'));
  await docker.createNetwork({
    Name: open.name,
    Internal: true,
    Labels: probeLabels,
    IPAM: {
      Driver: 'default',
      Config: [{ Subnet: open.subnet, IPRange: open.ipRange, Gateway: open.gateway }],
    },
  });
  try {
    const g = await d.probeIsolation(good, 'jumpmaster-egress:dev');
    check(
      'probe: on a drop network the gateway holds no host address and is unreachable, IPv6 off',
      g.listenerUp && !g.gatewayOnHost && !g.gatewayReachable && g.ipv6Disabled,
      g,
    );
    const o = await d.probeIsolation(open, 'jumpmaster-egress:dev');
    check(
      'probe control: without inhibit_ipv4 the probe sees the host at the gateway',
      o.listenerUp && o.gatewayOnHost && o.gatewayReachable,
      o,
    );
  } finally {
    await d.removeNetwork(good.name);
    await d.removeNetwork(open.name);
  }
}

// 1. enforce: allowed hosts work, everything else is refused, from the trooper and its service.
const allow = ['api.anthropic.com', 'github.com', 'registry.npmjs.org'];
const enforce = await drop('e2e-egress-enforce', 'enforce', allow, {
  probe: async (o) => {
    const net = o.egress;
    const [svc] = await byLabels(['jumpmaster.drop=e2e-egress-enforce', 'jumpmaster.service=db']);
    const service = docker.getContainer(svc.Id);
    const dns = await exec(service, ['sh', '-c', 'getent hosts example.com']);
    check('service: an external name does not resolve', dns.code !== 0, dns);
    const alias = await exec(service, ['sh', '-c', 'getent hosts jm-egress']);
    check(
      'service: jm-egress resolves to the proxy address',
      alias.code === 0 && alias.out.startsWith(net.proxy),
      alias,
    );
    const out = await exec(service, [
      'sh',
      '-c',
      'nc -z -w 3 1.1.1.1 443 && echo CONNECTED || echo refused',
    ]);
    check('service: a raw public IP is unreachable', out.out.endsWith('refused'), out);
    const gw = await exec(service, [
      'sh',
      '-c',
      `nc -z -w 3 ${net.gateway} ${env.E2E_HOST_PORT ?? 39999} && echo CONNECTED || echo refused`,
    ]);
    check('service: the gateway host listener is unreachable', gw.out.endsWith('refused'), gw);
    const v6 = await exec(service, [
      'sh',
      '-c',
      'cat /proc/sys/net/ipv6/conf/all/disable_ipv6; ip -6 addr show scope global | wc -l',
    ]);
    check('service: IPv6 disabled', v6.out.split('\n')[0] === '1', v6);

    const [px] = await byLabels(['jumpmaster.drop=e2e-egress-enforce', 'jumpmaster.egress=proxy']);
    const info = await docker.getContainer(px.Id).inspect();
    const outIp = info.NetworkSettings.Networks['jm-egress-out']?.IPAddress;
    const dropIp = info.NetworkSettings.Networks[net.name]?.IPAddress;
    check(
      'proxy: static .2 on the drop network, also on jm-egress-out',
      dropIp === net.proxy && Boolean(outIp),
      { dropIp, outIp },
    );
    check(
      'proxy: read-only root, no capabilities, no-new-privileges, non-root',
      info.HostConfig.ReadonlyRootfs === true &&
        info.HostConfig.CapDrop?.includes('ALL') &&
        info.HostConfig.SecurityOpt?.includes('no-new-privileges') &&
        info.Config.User === '10003:10003',
      { ro: info.HostConfig.ReadonlyRootfs, cap: info.HostConfig.CapDrop, user: info.Config.User },
    );
    check(
      'proxy: JM_EGRESS_BIND is its drop address',
      info.Config.Env.includes(`JM_EGRESS_BIND=${net.proxy}`),
    );
    const fromOut = await runOn(
      'jm-egress-out',
      `nc -z -w 3 ${outIp} 3128 && echo CONNECTED || echo refused; nc -z -w 3 ${net.proxy} 3128 && echo CONNECTED || echo refused`,
    );
    check(
      'jm-egress-out: the proxy accepts nothing there (its exit address or its drop address)',
      fromOut.out === 'refused\nrefused',
      fromOut,
    );
    // The host reaches container addresses on any bridge, ICC or not: only the bind stops it.
    const fromHost = await runOn(
      'host',
      `nc -z -w 3 ${outIp} 3128 && echo CONNECTED || echo refused`,
    );
    check(
      'host: the proxy accepts nothing on its jm-egress-out address',
      fromHost.out === 'refused',
      fromHost,
    );
    const netInfo = await docker.getNetwork(net.name).inspect();
    check(
      'drop network: internal, /28, no IPv6, no host-side gateway address',
      netInfo.Internal === true &&
        netInfo.EnableIPv6 === false &&
        netInfo.IPAM.Config[0].Subnet === net.subnet &&
        netInfo.Options['com.docker.network.bridge.inhibit_ipv4'] === 'true',
      { internal: netInfo.Internal, ipam: netInfo.IPAM.Config, opts: netInfo.Options },
    );
  },
});
const gate = enforce.result?.gates?.[0];
check(
  'enforce: the review drop completed (root git clone went through the proxy)',
  enforce.result?.status === 'completed',
  enforce.result?.reason ?? enforce.result,
);
check('enforce: every in-drop probe passed', gate?.exitCode === 0, gate?.outputTail);
console.log(`  probe: ${gate?.outputTail?.trim()}`);
const summary = enforce.result?.verdict ? JSON.parse(enforce.result.verdict.summary) : {};
check(
  'enforce: the agent ran with the proxy',
  summary.httpsProxy === 'http://jm-egress:3128',
  summary.httpsProxy,
);
check('enforce: no token in the result', !JSON.stringify(enforce.result).includes('E2EDUMMY'));
const ev = egressOf(enforce.events);
check(
  'enforce: egress events show github.com and registry.npmjs.org allowed',
  ev.has('allow github.com') && ev.has('allow registry.npmjs.org'),
  [...ev],
);
check('enforce: egress events show example.com denied', ev.has('deny example.com'), [...ev]);
console.log(`  egress events: ${JSON.stringify([...ev])}`);

// 2. monitor: an unlisted public host goes through and is reported; private addresses never do.
const monitor = await drop('e2e-egress-monitor', 'monitor', ['api.anthropic.com', 'github.com']);
const mgate = monitor.result?.gates?.[0];
check(
  'monitor: every in-drop probe passed',
  monitor.result?.status === 'completed' && mgate?.exitCode === 0,
  mgate?.outputTail ?? monitor.result,
);
const mev = egressOf(monitor.events);
check(
  'monitor: example.com and registry.npmjs.org reported unlisted',
  mev.has('unlisted example.com') && mev.has('unlisted registry.npmjs.org'),
  [...mev],
);
check('monitor: a name resolving to loopback is still denied', mev.has('deny localtest.me'), [
  ...mev,
]);

// 3. fail closed: a proxy that can't start means no trooper at all.
const closed = await drop('e2e-egress-closed', 'enforce', allow, {
  egressImage: 'jumpmaster-egress:absent',
});
check(
  'fail closed: no proxy, no trooper, the drop fails',
  closed.result?.status === 'failed' &&
    /^egress proxy failed to start: /.test(closed.result?.reason ?? '') &&
    closed.started.length === 0,
  { result: closed.result, started: closed.started },
);

console.log(failures === 0 ? 'egress e2e: pass' : `egress e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
