// Push e2e driver. Runs inside the stick image (push.sh mounts it) and drives the stick's own
// runDrop, pushOnce and DockerDriver against the real engine, with a fake server client, on two
// implement drops whose trooper (the push e2e image) reaches a local bare remote over git://:
//   1. final: the agent completes, the gates pass, the result asks for a final push; the push
//      container pushes the gated commit, and the bare remote's branch is that SHA;
//   2. interrupt: the agent stops at the turn cap; the trooper checkpoints, and the push container
//      pushes the checkpoint SHA.
// On each: the agent planted core.fsmonitor in the working copy (its own git runs it: the control),
// and the push container never does; an agent-uid process left by the agent container is not
// alive in the push container when it prints ready; the agent container's only mount is the
// volume; the write token never reaches the agent container (create spec, environment or stdin);
// the push container gets no token before ready, and the grant is written only after ready; the
// volume is gone at the end. Prints one line per check; the last line is `push e2e: ok`.
// From the environment: E2E_REMOTE (the bare remote's container name).
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/stick/dist/main.js');
const Docker = require('dockerode');
const { DockerDriver } = await import('/app/apps/stick/dist/docker.js');
const { runDrop } = await import('/app/apps/stick/dist/runner.js');
const { PendingPushes, pushOnce, pushContainer } = await import('/app/apps/stick/dist/push.js');
const { REPO_MOUNT } = await import('/app/apps/stick/dist/volumes.js');
const { READY_LINE } = await import('/app/packages/protocol/dist/index.js');

const TROOPER = 'jumpmaster-trooper:e2e-push';
const STICK = 'e2e-push-stick';
const OWNER = 'e2e';
const NAME = 'push';
// Distinct, recognisable values: the read token the agent container clones with, the write token
// only the grant carries, and the Claude token.
const READ_TOKEN = 'ghp_E2EREADTOKENreadtokenREADTOKEN0001';
const WRITE_TOKEN = 'ghp_E2EWRITETOKENwritetokenWRITE00002';
const CLAUDE_TOKEN = 'sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY';

const real = new Docker();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'ok' : 'FAIL'}: ${label}${ok || detail === '' ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`,
  );
  if (!ok) failures++;
};

/** Demuxes a non-TTY log or exec stream buffer into its text. */
function demux(raw) {
  let out = '';
  for (let i = 0; i + 8 <= raw.length; ) {
    const len = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out;
}

/** Runs a command in a running container; resolves with its exit code and output. */
async function exec(container, cmd) {
  const e = await real.getContainer(container).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });
  let out = '';
  const sink = { write: (c) => void (out += c.toString('utf8')) };
  real.modem.demuxStream(stream, sink, sink);
  await new Promise((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  const { ExitCode } = await e.inspect();
  return { code: ExitCode, out: out.trim() };
}

/** Every container create spec the stick sends to the engine, by name. */
const created = new Map();
/** The engine API, with container creation recorded (the spec, as sent). */
const docker = Object.create(real);
docker.createContainer = async (spec) => {
  const c = await real.createContainer(spec);
  if (spec.name) created.set(spec.name, { spec, id: c.id });
  return c;
};

/**
 * The stick's own driver. It records each container's stdin (the payload and every later line),
 * when a container printed the ready line, and, at the moment the grant is about to be written,
 * the agent-uid processes alive in that container. Before a volume is removed it reads what the
 * planted fsmonitor and the lingering process wrote there.
 */
class E2EDriver extends DockerDriver {
  stdin = new Map();
  ready = new Map();
  atGrant = new Map();
  peeked = new Map();
  order = [];
  async start(o) {
    this.stdin.set(o.name, [o.payload]);
    const h = await super.start(o);
    const name = o.name;
    const self = this;
    return {
      ...h,
      logs() {
        const inner = h.logs();
        return (async function* () {
          for await (const line of inner) {
            if (line === READY_LINE && !self.ready.has(name)) {
              self.ready.set(name, Date.now());
              self.order.push(`${name}: ready`);
            }
            yield line;
          }
        })();
      },
      async writeLine(line) {
        self.order.push(`${name}: write`);
        self.stdin.get(name).push(line);
        if (name.startsWith('jumpmaster-push-')) {
          // What the trooper's agentProcessesAlive counts: /proc entries owned by the agent uid.
          const r = await exec(name, [
            'sh',
            '-c',
            'n=0; for s in /proc/[0-9]*/status; do grep -qE "^Uid:[[:space:]]+10001[[:space:]]" "$s" 2>/dev/null && n=$((n+1)); done; echo "$n $(cat /etc/hostname)"',
          ]);
          const [alive, host] = r.out.split(' ');
          self.atGrant.set(name, { alive: Number(alive), host, readyBefore: self.ready.has(name) });
        }
        return h.writeLine(line);
      },
    };
  }
  async removeVolume(volume) {
    // Read as root with the engine's default capabilities: the agent's 0700 tree is readable.
    const c = await real.createContainer({
      Image: TROOPER,
      name: `jm-e2e-peek-${volume}`,
      Entrypoint: ['sh', '-c'],
      Cmd: [
        'cat /v/.git/jm-fsm-marker 2>/dev/null; echo ---; cat /v/.git/jm-linger 2>/dev/null; true',
      ],
      User: '0',
      Labels: { 'jumpmaster.stick': STICK },
      HostConfig: {
        NetworkMode: 'none',
        Mounts: [{ Type: 'volume', Source: volume, Target: '/v', ReadOnly: true }],
      },
    });
    await c.start();
    await c.wait();
    const text = demux(await c.logs({ stdout: true, stderr: true }));
    await c.remove({ force: true });
    const [fsm, linger] = text.split('---');
    const lines = (s) =>
      (s ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    this.peeked.set(volume, { fsm: lines(fsm), linger: lines(linger) });
    return super.removeVolume(volume);
  }
}

function payload(dropId, mode, branch) {
  return {
    protocol: 1,
    dropId,
    epoch: 1,
    role: 'implement',
    repo: { owner: OWNER, name: NAME, defaultBranch: 'main' },
    issue: { number: 1, title: 'e2e', body: 'e2e' },
    branch,
    gates: [{ name: 'feature', run: 'test -f feature.txt', timeoutMinutes: 2 }],
    model: 'm',
    maxTurns: 1,
    promptVersion: 'e2e',
    prompt: `implement E2E_MODE=${mode}`,
    image: TROOPER,
    protectedPaths: [],
    credentials: { claudeToken: CLAUDE_TOKEN, forgeToken: READ_TOKEN },
    resume: false,
  };
}

/** The server, faked: it accepts the push request, plans the push and grants it after ready. */
function client(driver, branch) {
  return {
    features: new Set(['push-v1']),
    events: [],
    result: undefined,
    grants: [],
    pushResults: [],
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
    async salvage() {
      return 'refused';
    },
    async pushPlan() {
      return { branch, salvage: false };
    },
    async pushGrant(dropId, epoch) {
      const push = this.result?.push;
      this.grants.push({ readyFirst: driver.ready.has(pushContainer(dropId, epoch)) });
      driver.order.push('server: grant');
      return {
        grant: {
          token: WRITE_TOKEN,
          owner: OWNER,
          name: NAME,
          branch,
          base: 'main',
          lease: '',
          ...(push?.kind === 'final' ? { expectSha: push.expectSha } : {}),
          protectedPaths: [],
          secrets: [READ_TOKEN, CLAUDE_TOKEN],
        },
      };
    },
    async postPushResult(_d, _e, r) {
      this.pushResults.push(r);
      return 'ok';
    },
  };
}

async function remoteSha(branch) {
  const r = await exec(process.env.E2E_REMOTE, [
    'git',
    '-C',
    `/srv/${OWNER}/${NAME}.git`,
    'rev-parse',
    '--verify',
    '-q',
    `refs/heads/${branch}`,
  ]);
  return r.code === 0 ? r.out : null;
}

async function scenario(dropId, mode, wantStatus, wantKind) {
  const branch = `jm/e2e-${mode}`;
  const driver = new E2EDriver(docker);
  const pending = new PendingPushes();
  const c = client(driver, branch);
  const logs = [];
  const log = (l) => logs.push(l);
  const t0 = Date.now();
  await runDrop(payload(dropId, mode, branch), {
    client: c,
    driver,
    stickId: STICK,
    allowedImages: new Set([TROOPER]),
    trooperImage: TROOPER,
    pending,
    baseImage: () => ({ ok: true }),
    heartbeatMs: 60_000,
    log,
  });
  const r = c.result;
  check(
    `${mode}: the agent container's result is ${wantStatus} and asks for a ${wantKind} push`,
    r?.status === wantStatus &&
      r?.push?.kind === wantKind &&
      /^[0-9a-f]{40}$/.test(r?.headSha ?? ''),
    { result: r, logs: logs.slice(-5) },
  );
  if (wantKind === 'final') {
    check(
      `${mode}: the final push names the gated commit and the gate passed`,
      r?.push?.expectSha === r?.headSha && r?.gates?.[0]?.exitCode === 0,
      r,
    );
  }
  const agentName = [...created.keys()].find((n) => n.startsWith(`jumpmaster-drop-${dropId}-`));
  const agent = created.get(agentName);
  const entry = pending.get(dropId);
  check(
    `${mode}: the volume is handed to the push loop`,
    entry?.volume?.startsWith(`jm-drop-${dropId}-1-`),
    entry,
  );
  check(
    `${mode}: the agent container is gone before the push loop holds the volume`,
    (await real.listContainers({ all: true, filters: { name: [agentName ?? 'none'] } })).length ===
      0,
  );
  const mounts = agent?.spec?.HostConfig?.Mounts ?? [];
  check(
    `${mode}: the agent container's only mount is the drop's volume, at ${REPO_MOUNT}`,
    mounts.length === 1 &&
      mounts[0].Type === 'volume' &&
      mounts[0].Source === entry?.volume &&
      mounts[0].Target === REPO_MOUNT &&
      (agent.spec.HostConfig.Binds ?? []).length === 0,
    { mounts, binds: agent?.spec?.HostConfig?.Binds },
  );
  const agentSaw = JSON.stringify({ spec: agent?.spec, stdin: driver.stdin.get(agentName) });
  check(
    `${mode}: the write token never reached the agent container (spec, environment, stdin)`,
    agent !== undefined && !agentSaw.includes(WRITE_TOKEN) && agentSaw.includes(READ_TOKEN),
  );
  check(
    `${mode}: the agent container got no stdin after its payload`,
    driver.stdin.get(agentName)?.length === 1,
  );
  if (!entry) return;

  const out = await pushOnce(entry, {
    client: c,
    driver,
    stickId: STICK,
    image: TROOPER,
    pending,
    heartbeatMs: 60_000,
    log,
  });
  const name = pushContainer(dropId, 1);
  const push = created.get(name);
  const pr = c.pushResults[0];
  check(`${mode}: the push attempt is done`, out === 'done', { out, logs: logs.slice(-6) });
  check(
    `${mode}: the push container ran the stick's trooper image with only the volume mounted`,
    push?.spec?.Image === TROOPER &&
      push.spec.HostConfig.Mounts?.length === 1 &&
      push.spec.HostConfig.Mounts[0].Source === entry.volume,
    push?.spec?.HostConfig?.Mounts,
  );
  const before = JSON.stringify({ spec: push?.spec, payload: driver.stdin.get(name)?.[0] });
  check(
    `${mode}: the push container got no token before ready (spec, environment, payload)`,
    !before.includes(WRITE_TOKEN) && !before.includes(READ_TOKEN) && !before.includes(CLAUDE_TOKEN),
  );
  check(
    `${mode}: ready came first, then the grant was asked for and written (once)`,
    c.grants.length === 1 &&
      c.grants[0].readyFirst &&
      JSON.stringify(driver.order.filter((o) => o.startsWith(name) || o === 'server: grant')) ===
        JSON.stringify([`${name}: ready`, 'server: grant', `${name}: write`]),
    driver.order,
  );
  const at = driver.atGrant.get(name);
  check(
    `${mode}: no agent-uid process alive in the push container at ready (agentProcessesAlive 0)`,
    at?.alive === 0 && at.readyBefore === true,
    at,
  );
  check(
    `${mode}: the push result is pushed, with the agent's commit`,
    pr?.status === 'pushed' && pr.headSha === r?.headSha && pr.alreadyThere === false,
    pr,
  );
  const sha = await remoteSha(branch);
  check(
    `${mode}: the bare remote's ${branch} is ${r?.headSha?.slice(0, 12)}`,
    sha === r?.headSha,
    sha,
  );
  const seen = driver.peeked.get(entry.volume);
  const agentHost = agent?.id?.slice(0, 12);
  check(
    `${mode}: control: the planted fsmonitor ran in the agent container`,
    (seen?.fsm ?? []).includes(agentHost),
    { seen, agentHost },
  );
  check(
    `${mode}: the planted fsmonitor never ran in the push container (its marker is absent)`,
    seen !== undefined && !seen.fsm.includes(at?.host) && seen.fsm.every((h) => h === agentHost),
    { seen, pushHost: at?.host },
  );
  check(
    `${mode}: the lingering agent-uid process ran in the agent container, never in the push container`,
    (seen?.linger ?? []).includes(agentHost) && !(seen?.linger ?? []).includes(at?.host),
    { linger: seen?.linger, agentHost, pushHost: at?.host },
  );
  const vols = await docker.listVolumes({ filters: { label: [`jumpmaster.drop=${dropId}`] } });
  const left = await real.listContainers({
    all: true,
    filters: { label: [`jumpmaster.drop=${dropId}`] },
  });
  check(
    `${mode}: the volume is removed and no container is left`,
    (vols.Volumes ?? []).length === 0 && left.length === 0 && pending.size() === 0,
    { vols: vols.Volumes?.map((v) => v.Name), left: left.map((x) => x.Names) },
  );
  console.log(`  ${mode}: ${((Date.now() - t0) / 1000).toFixed(1)}s, pushed ${r?.headSha}`);
}

check('the bare remote has no e2e branch yet', (await remoteSha('jm/e2e-final')) === null);
await scenario('e2e-push-final', 'final', 'completed', 'final');
await scenario('e2e-push-interrupt', 'interrupt', 'interrupted', 'checkpoint');

console.log(failures === 0 ? 'push e2e: ok' : `push e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
