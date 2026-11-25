// Clone e2e driver. Runs inside the stick image (clone.sh mounts it) and drives the stick's own
// runDrop, runClone and DockerDriver against the real engine, with a fake server client, on two
// implement drops whose repo is a GitLab project with a provided mirror (`repo.mirror:
// "provided"`). The stand-in GitLab host is a local smart-HTTPS remote (clone-remote.mjs) at a bare
// https:// origin; the clone e2e image trusts its test CA. The clone plan carries no egress (the
// egress proxy refuses private addresses), so the clone container runs on the default bridge.
//   1. main: the clone container clones the remote into the mirror volume with the planted read
//      deploy token; the agent (fake Claude: no commit, no call) runs on the read-only mirror.
//      While the fake Claude waits, the agent container is searched for every form of the token:
//      its create spec, environment, stdin payload and files (the engine's export of it), its
//      processes' environments, and every volume it mounts (the engine's archive of each).
//   2. hostile: the remote answers every request with a redirect to another local host; the clone
//      fails cleanly and that host never sees the token.
// Prints one `ok:` or `FAIL:` line per check; the last line is `clone e2e: ok`.
// From the environment: E2E_REMOTE and E2E_OTHER (the containers), E2E_ORIGIN and
// E2E_OTHER_ORIGIN (their https:// origins), E2E_USERNAME and E2E_TOKEN (the planted credential).
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire('/app/apps/stick/dist/main.js');
const Docker = require('dockerode');
const { DockerDriver } = await import('/app/apps/stick/dist/docker.js');
const { runDrop } = await import('/app/apps/stick/dist/runner.js');
const { cloneContainer, cloneNetwork } = await import('/app/apps/stick/dist/clone.js');
const { PendingPushes } = await import('/app/apps/stick/dist/push.js');
const { MIRROR_MOUNT, REPO_MOUNT } = await import('/app/apps/stick/dist/volumes.js');
const { READY_LINE } = await import('/app/packages/protocol/dist/index.js');

const TROOPER = 'jumpmaster-trooper:e2e-clone';
const STICK = 'e2e-clone-stick';
const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const REMOTE = env('E2E_REMOTE');
const OTHER = env('E2E_OTHER');
const ORIGIN = env('E2E_ORIGIN');
const OTHER_ORIGIN = env('E2E_OTHER_ORIGIN');
const USERNAME = env('E2E_USERNAME');
const TOKEN = env('E2E_TOKEN');
const FORGE = { kind: 'gitlab', origin: ORIGIN, projectPath: 'e2e/clone' };
const CLAUDE_TOKEN = 'sk-ant-' + 'oat01-E2EDUMMYDUMMYDUMMYDUMMY';
const b64 = (s) => Buffer.from(s).toString('base64');
/** The planted token in every form it could travel in: plain, `<username>:<token>`, basic auth. */
const FORMS = {
  plain: TOKEN,
  'username:token': `${USERNAME}:${TOKEN}`,
  'basic-auth base64 of username:token': b64(`${USERNAME}:${TOKEN}`),
  'basic-auth base64 of oauth2:token': b64(`oauth2:${TOKEN}`),
};
const NEEDLES = Object.values(FORMS);
/** What the fake Claude's own file holds: an export that has it was really read. */
const EXPORT_CONTROL = '/tmp/jm-e2e-release';
/** What every git directory's HEAD holds: a volume archive that has it was really read. */
const VOLUME_CONTROL = 'ref: refs/heads/';

const real = new Docker();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'ok' : 'FAIL'}: ${label}${ok || detail === '' ? '' : ` (${JSON.stringify(detail).slice(0, 800)})`}`,
  );
  if (!ok) failures++;
};

/** The names of the token's forms that `text` holds; never the forms themselves. */
const formsIn = (text) =>
  Object.entries(FORMS)
    .filter(([, v]) => String(text).includes(v))
    .map(([k]) => k);

/**
 * Which of `needles` a byte stream (a tar from the engine, here) holds, read in pieces with an
 * overlap, so a needle split across two pieces is found. A tar holds each file's bytes as they
 * are; what git stores zlib-compressed (objects, packs) is searched as stored.
 */
async function streamFind(stream, needles) {
  const bufs = needles.map((n) => Buffer.from(n));
  const keep = Math.max(...bufs.map((b) => b.length)) - 1;
  const found = new Set();
  let carry = Buffer.alloc(0);
  let bytes = 0;
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += piece.length;
    const window = carry.length > 0 ? Buffer.concat([carry, piece]) : piece;
    bufs.forEach((b, i) => {
      if (window.includes(b)) found.add(needles[i]);
    });
    carry = Buffer.from(window.subarray(Math.max(0, window.length - keep)));
  }
  return { found, bytes };
}
const namesOf = (found) => formsIn([...found].join('\n'));

/** Runs a command in a running container as `user`; resolves with its exit code and output. */
async function exec(container, cmd, user = '0') {
  const e = await real.getContainer(container).exec({
    Cmd: cmd,
    User: user,
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

/** A stand-in host's access log, one parsed JSON line per request. */
async function accessLog(container) {
  const r = await exec(container, ['sh', '-c', 'cat /srv/access.log 2>/dev/null; true']);
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function remoteSha() {
  const r = await exec(REMOTE, [
    'git',
    '--git-dir=/srv/git/e2e/clone.git',
    'rev-parse',
    '--verify',
    'refs/heads/main',
  ]);
  return r.code === 0 ? r.out : null;
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

/** Each process's environment, one variable per line; readable to `cat` as the exec's user. */
const ENVIRON =
  'for f in /proc/[0-9]*/environ; do tr "\\000" "\\n" 2>/dev/null < "$f"; echo; done 2>/dev/null; true';

/** An archive of `volume` read through a container that is never started; then removed. */
async function volumeFind(volume, needles) {
  const c = await real.createContainer({
    Image: TROOPER,
    name: `jm-e2e-peek-${volume}`,
    Entrypoint: ['true'],
    Labels: { 'jumpmaster.stick': STICK },
    HostConfig: {
      NetworkMode: 'none',
      Mounts: [{ Type: 'volume', Source: volume, Target: '/v', ReadOnly: true }],
    },
  });
  try {
    return await streamFind(await c.getArchive({ path: '/v' }), needles);
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/**
 * Once the fake Claude is waiting in the agent container, searches it; then releases the fake
 * Claude, whatever happened. Needles go only into this process, never into the container.
 */
async function holdAndSearch(name) {
  const r = { waiting: false };
  try {
    for (let i = 0; i < 600 && !r.waiting; i++) {
      try {
        r.waiting = (await exec(name, ['test', '-e', '/tmp/jm-e2e-waiting'])).code === 0;
      } catch (e) {
        // The agent container is gone (or never ran): nothing to hold.
        r.error = String(e?.message ?? e);
        return r;
      }
      if (!r.waiting) await sleep(500);
    }
    if (!r.waiting) return r;
    const info = await real.getContainer(name).inspect();
    r.env = info.Config?.Env ?? [];
    r.mounts = info.Mounts ?? [];
    r.environ = {};
    for (const user of ['0', '10001', '10002'])
      r.environ[user] = (await exec(name, ['sh', '-c', ENVIRON], user)).out;
    r.mirrorWrite = await exec(name, [
      'sh',
      '-c',
      `touch ${MIRROR_MOUNT}/jm-e2e-write 2>&1 && echo wrote`,
    ]);
    r.mirrorHead = await exec(name, [
      'git',
      '-c',
      'safe.directory=*',
      `--git-dir=${MIRROR_MOUNT}`,
      'rev-parse',
      '--verify',
      'refs/heads/main',
    ]);
    r.exported = await streamFind(await real.getContainer(name).export(), [
      ...NEEDLES,
      EXPORT_CONTROL,
    ]);
    r.volumes = [];
    for (const m of r.mounts.filter((x) => x.Type === 'volume'))
      r.volumes.push({
        name: m.Name,
        target: m.Destination,
        rw: m.RW,
        ...(await volumeFind(m.Name, [...NEEDLES, VOLUME_CONTROL])),
      });
  } catch (e) {
    r.error = String(e?.stack ?? e);
  } finally {
    await exec(name, ['touch', '/tmp/jm-e2e-release']).catch(() => {});
  }
  return r;
}

/**
 * The stick's own driver. It records each container's stdin (the payload and every later line),
 * when a container printed the ready line, and the clone container's bridge address. Before the
 * agent container is created it records what the engine still holds for the drop, and once the
 * agent runs it searches it (`holdAndSearch`).
 */
class E2EDriver extends DockerDriver {
  stdin = new Map();
  ready = new Map();
  ips = new Map();
  beforeAgent = new Map();
  searched = new Map();
  order = [];
  async start(o) {
    const name = o.name;
    const dropId = o.labels?.['jumpmaster.drop'];
    const agent = name.startsWith('jumpmaster-drop-');
    if (agent) {
      const clones = await real.listContainers({
        all: true,
        filters: { name: [cloneContainer(dropId, 1)] },
      });
      const nets = await real.listNetworks({ filters: { name: ['jm-clone-'] } });
      const proxies = await real.listContainers({
        all: true,
        filters: { name: [`jm-egress-${dropId}`] },
      });
      this.beforeAgent.set(dropId, {
        clones: clones.map((c) => c.Names),
        networks: nets.map((n) => n.Name),
        proxies: proxies.map((c) => c.Names),
        remoteLines: (await accessLog(REMOTE)).length,
      });
      this.order.push(`${name}: create`);
    }
    this.stdin.set(name, [o.payload]);
    const h = await super.start(o);
    if (name.startsWith('jumpmaster-clone-')) {
      const info = await real
        .getContainer(name)
        .inspect()
        .catch(() => null);
      this.ips.set(name, info?.NetworkSettings?.Networks?.bridge?.IPAddress ?? null);
    }
    if (agent) this.searched.set(name, holdAndSearch(name));
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
        return h.writeLine(line);
      },
    };
  }
}

function payload(dropId) {
  return {
    protocol: 1,
    dropId,
    epoch: 1,
    role: 'implement',
    repo: { owner: 'e2e', name: 'clone', defaultBranch: 'main', forge: FORGE, mirror: 'provided' },
    issue: { number: 1, title: 'e2e', body: 'e2e' },
    branch: `jm/${dropId}`,
    gates: [],
    model: 'm',
    maxTurns: 1,
    promptVersion: 'e2e',
    prompt: 'implement: change nothing',
    image: TROOPER,
    protectedPaths: [],
    // A provided mirror needs no forge token: the agent container gets none.
    credentials: { claudeToken: CLAUDE_TOKEN },
    resume: false,
  };
}

/**
 * The server, faked: it plans the clone with no egress, grants the planted read deploy token
 * (with its username) after ready, and takes the drop's result. Nothing is pushed: a push plan
 * or grant asked for is recorded and refused.
 */
function client(driver) {
  return {
    features: new Set(['push-v1', 'clone-v1']),
    events: [],
    result: undefined,
    plans: 0,
    grants: [],
    pushAsked: 0,
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
      this.pushAsked++;
      throw new Error('e2e: nothing is pushed');
    },
    async pushGrant() {
      this.pushAsked++;
      throw new Error('e2e: nothing is pushed');
    },
    async clonePlan() {
      this.plans++;
      driver.order.push('server: plan');
      return { forge: FORGE, maxBytes: 64 * 1024 * 1024 };
    },
    async cloneGrant(dropId, epoch) {
      this.grants.push({ readyFirst: driver.ready.has(cloneContainer(dropId, epoch)) });
      driver.order.push('server: grant');
      return { grant: { token: TOKEN, username: USERNAME, forge: FORGE, secrets: [] } };
    },
  };
}

async function drop(dropId) {
  const driver = new E2EDriver(docker);
  const c = client(driver);
  const pending = new PendingPushes();
  const logs = [];
  const t0 = Date.now();
  await runDrop(payload(dropId), {
    client: c,
    driver,
    stickId: STICK,
    allowedImages: new Set([TROOPER]),
    trooperImage: TROOPER,
    pending,
    baseImage: () => ({ ok: true }),
    heartbeatMs: 60_000,
    ceiling: null,
    active: new Set(),
    log: (l) => logs.push(l),
  });
  const clone = cloneContainer(dropId, 1);
  const agentName = [...created.keys()].find((n) => n.startsWith(`jumpmaster-drop-${dropId}-`));
  const mirrorVolume = created
    .get(clone)
    ?.spec?.HostConfig?.Mounts?.find((m) => m.Target === MIRROR_MOUNT)?.Source;
  const vols = await real.listVolumes({ filters: { label: [`jumpmaster.drop=${dropId}`] } });
  const left = await real.listContainers({
    all: true,
    filters: { label: [`jumpmaster.drop=${dropId}`] },
  });
  return {
    dropId,
    driver,
    c,
    pending,
    logs,
    clone,
    agentName,
    mirrorVolume,
    vols: (vols.Volumes ?? []).map((v) => v.Name),
    left: left.map((x) => x.Names),
    secs: ((Date.now() - t0) / 1000).toFixed(1),
  };
}

/** Each place in the agent container, and which forms of the token it holds. */
function absent(where, holds, control = true, detail = '') {
  check(
    `the planted token is absent from the agent container's ${where} (plain, username:token, basic-auth)`,
    control && holds.length === 0,
    { holds, control, detail },
  );
}

// ---- 1. main: clone, then the agent on the provided mirror --------------------------------
const sha = await remoteSha();
check("the remote's main has a commit", /^[0-9a-f]{40}$/.test(sha ?? ''), sha);
const baseline = (await accessLog(REMOTE)).length;
const otherBaseline = (await accessLog(OTHER)).length;
const main = await drop('e2e-clone-main');
const { driver, c } = main;
const cloneSeen = created.get(main.clone);
check(
  'the stick ran a clone container from its trooper image, mirror volume only, no egress network',
  cloneSeen?.spec?.Image === TROOPER &&
    cloneSeen.spec.HostConfig.Mounts?.length === 1 &&
    main.mirrorVolume?.startsWith(`jm-mirror-${main.dropId}-1-`) &&
    cloneSeen.spec.NetworkingConfig === undefined &&
    c.plans === 1,
  { spec: cloneSeen?.spec?.HostConfig, plans: c.plans, logs: main.logs.slice(-6) },
);
check(
  'the clone container printed ready before the grant was written to its stdin',
  c.grants.length === 1 &&
    c.grants[0].readyFirst &&
    JSON.stringify(
      driver.order.filter((o) => o.startsWith(main.clone) || o === 'server: grant'),
    ) === JSON.stringify([`${main.clone}: ready`, 'server: grant', `${main.clone}: write`]),
  driver.order,
);
const cloneStdin = driver.stdin.get(main.clone) ?? [];
check(
  "the clone container's payload (before ready) holds no form of the token",
  cloneStdin.length > 0 && formsIn(cloneStdin[0]).length === 0,
  formsIn(cloneStdin[0] ?? ''),
);
const controlStream = await streamFind(
  Readable.from([Buffer.from(cloneStdin.join('\n'))]),
  NEEDLES,
);
check(
  "control: the same search finds the planted token in the clone container's grant on its stdin",
  formsIn(cloneStdin.join('\n')).includes('plain') &&
    namesOf(controlStream.found).includes('plain'),
  { text: formsIn(cloneStdin.join('\n')), stream: namesOf(controlStream.found) },
);
check(
  'the implement drop on the provided mirror ended no_changes, and nothing was pushed',
  c.result?.status === 'no_changes' && c.result.push === undefined && c.pushAsked === 0,
  { result: c.result, logs: main.logs.slice(-8) },
);

const before = driver.beforeAgent.get(main.dropId);
check(
  'the clone container is gone before the agent container is created',
  before !== undefined && before.clones.length === 0 && cloneSeen !== undefined,
  before,
);
check(
  `no jm-clone- network or egress proxy exists for the drop (${cloneNetwork(main.dropId, 1)}) before the agent container is created`,
  before !== undefined && before.networks.length === 0 && before.proxies.length === 0,
  before,
);

const agent = created.get(main.agentName ?? '');
const found = (await driver.searched.get(main.agentName ?? '')) ?? {};
check(
  'the fake Claude ran in the agent container and was held while it was searched',
  agent !== undefined && found.waiting === true && found.error === undefined,
  { agent: main.agentName, found },
);
const specMirror = agent?.spec?.HostConfig?.Mounts?.find((m) => m.Target === MIRROR_MOUNT);
const liveMirror = found.mounts?.find((m) => m.Destination === MIRROR_MOUNT);
check(
  `the mirror at ${MIRROR_MOUNT} is read-only in the agent container (spec, engine, a write as root)`,
  specMirror?.ReadOnly === true &&
    specMirror.Source === main.mirrorVolume &&
    liveMirror?.RW === false &&
    found.mirrorWrite?.code !== 0 &&
    /read-only/i.test(found.mirrorWrite?.out ?? ''),
  { specMirror, liveMirror, write: found.mirrorWrite },
);
check(
  `the mirror at ${MIRROR_MOUNT} holds the remote's commit ${sha?.slice(0, 12)}`,
  found.mirrorHead?.code === 0 && found.mirrorHead.out === sha,
  found.mirrorHead,
);

// The token in the agent container: every place it could be.
absent('create spec', formsIn(JSON.stringify(agent?.spec ?? null)), agent !== undefined);
absent(
  'environment (as created and as the engine runs it)',
  formsIn(JSON.stringify([agent?.spec?.Env ?? [], found.env ?? []])),
  Array.isArray(found.env) && found.env.length > 0,
);
const agentStdin = driver.stdin.get(main.agentName ?? '') ?? [];
absent(
  'stdin payload',
  formsIn(agentStdin.join('\n')),
  agentStdin.length === 1 && agentStdin[0].includes(CLAUDE_TOKEN),
  { lines: agentStdin.length },
);
absent(
  `files (the engine's export, ${Math.round((found.exported?.bytes ?? 0) / 1e6)} MB)`,
  namesOf(found.exported?.found ?? new Set()),
  found.exported?.found?.has(EXPORT_CONTROL) === true,
  'control: the export must hold the fake Claude',
);
const environ = found.environ ?? {};
absent(
  "processes' environments (/proc/*/environ as root, the agent and the gate)",
  formsIn(Object.values(environ).join('\n')),
  /JM_AGENT_UID=10001/.test(environ['0'] ?? '') &&
    /CLAUDE_CONFIG_DIR=/.test(environ['10001'] ?? ''),
  'control: the dumps must hold the trooper (root) and the fake Claude (agent) environments',
);
const vols = found.volumes ?? [];
check(
  `the agent container mounts the repo volume at ${REPO_MOUNT} and the mirror volume, and nothing else`,
  vols.length === 2 &&
    vols.some((v) => v.target === REPO_MOUNT) &&
    vols.some((v) => v.target === MIRROR_MOUNT && v.name === main.mirrorVolume) &&
    (found.mounts ?? []).length === 2,
  found.mounts,
);
for (const v of vols)
  absent(
    `volume ${v.name} at ${v.target} (the engine's archive, ${Math.round(v.bytes / 1e3)} kB)`,
    namesOf(v.found),
    v.found.has(VOLUME_CONTROL),
    'control: the archive must hold a git HEAD',
  );

// The remote: only the clone's requests, never the agent's.
const remoteLog = await accessLog(REMOTE);
const cloneIp = driver.ips.get(main.clone);
const cloneReqs = remoteLog.slice(baseline, before?.remoteLines ?? baseline);
check(
  `the remote's log shows only the clone's requests (${cloneReqs.length}, from the clone container's address ${cloneIp}, authorized)`,
  cloneReqs.length > 0 &&
    typeof cloneIp === 'string' &&
    cloneIp !== '' &&
    cloneReqs.every((l) => l.ip === cloneIp && l.auth === 'ok' && l.status === 200),
  cloneReqs,
);
check(
  'the agent container made no call to the remote (no request after the clone)',
  before !== undefined && remoteLog.length === before.remoteLines,
  remoteLog.slice(before?.remoteLines ?? 0),
);
check(
  'the mirror volume is removed at drop end, with the repo volume, and no container is left',
  main.mirrorVolume !== undefined &&
    !main.vols.includes(main.mirrorVolume) &&
    main.vols.length === 0 &&
    main.left.length === 0 &&
    main.pending.size() === 0,
  { vols: main.vols, left: main.left },
);
check(
  "the stick's log holds no form of the token",
  formsIn(main.logs.join('\n')).length === 0,
  formsIn(main.logs.join('\n')),
);
console.log(`  main: ${main.secs}s`);

// ---- 2. hostile: the remote redirects every request to another local host --------------------
await exec(REMOTE, ['sh', '-c', 'printf "%s\\n" "$1" > /srv/redirect', 'sh', OTHER_ORIGIN]);
const hostileBase = (await accessLog(REMOTE)).length;
const hostile = await drop('e2e-clone-hostile');
await exec(REMOTE, ['rm', '-f', '/srv/redirect']);
const hostileIp = hostile.driver.ips.get(hostile.clone);
const redirected = (await accessLog(REMOTE)).slice(hostileBase);
check(
  'hostile: the remote answered the clone with a redirect to the other host',
  redirected.length > 0 &&
    redirected.every(
      (l) => l.ip === hostileIp && l.status === 302 && l.location.startsWith(`${OTHER_ORIGIN}/`),
    ),
  redirected,
);
const cloneFailed = hostile.logs
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .find((l) => l?.event === 'clone' && l.what === 'failed');
check(
  'hostile: the clone failed cleanly: a failed clone result',
  cloneFailed !== undefined && hostile.driver.ready.has(hostile.clone),
  hostile.logs.slice(-6),
);
check(
  'hostile: the clone failed cleanly: the drop failed, and no agent container was created',
  hostile.c.result?.status === 'failed' && hostile.agentName === undefined,
  { result: hostile.c.result, agent: hostile.agentName },
);
check(
  'hostile: the clone failed cleanly: the mirror volume removed and no container left',
  hostile.mirrorVolume !== undefined && hostile.vols.length === 0 && hostile.left.length === 0,
  { vols: hostile.vols, left: hostile.left },
);
check(
  "hostile: the failed result and the stick's log hold no form of the token",
  formsIn(JSON.stringify(hostile.c.result ?? null)).length === 0 &&
    formsIn(hostile.logs.join('\n')).length === 0,
);
const otherLog = await accessLog(OTHER);
const otherSince = otherLog.slice(otherBaseline);
check(
  `hostile: the other host's log shows no request carrying an Authorization header or the token (${otherSince.length} request(s) since the drops began)`,
  otherBaseline > 0 &&
    otherLog.every(
      (l) =>
        !Object.keys(l.headers ?? {}).some((k) => k.toLowerCase() === 'authorization') &&
        formsIn(JSON.stringify(l)).length === 0,
    ),
  { otherBaseline, otherSince: otherSince.map((l) => ({ ip: l.ip, path: l.path })) },
);
console.log(`  hostile: ${hostile.secs}s`);

console.log(failures === 0 ? 'clone e2e: ok' : `clone e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
