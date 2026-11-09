// Image verification e2e driver. Runs inside the stick image (verify.sh mounts it), under the
// image's own signed policy, its real cosign and its read-only root with /state writable, and
// drives the stick's own startup check and runDrop against the real engine with a fake server
// client. Prints one line per check and exits non-zero on any failure.
// From the environment: E2E_REPO, E2E_BRANCH, E2E_SHA, E2E_UNSIGNED (a digest reference to an
// unsigned copy of the e2e trooper in a local registry), E2E_OTHER_SIGNED (an image signed keyless
// by another identity).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/stick/dist/main.js');
const Docker = require('dockerode');
const { DockerDriver } = await import('/app/apps/stick/dist/docker.js');
const { runDrop } = await import('/app/apps/stick/dist/runner.js');
const { advertisedCapabilities, loadRelease } = await import('/app/apps/stick/dist/state.js');
const { execCosign, prepareImageTrust } = await import('/app/apps/stick/dist/verify.js');

const env = process.env;
const [owner, name] = (env.E2E_REPO ?? '').split('/');
const UNSIGNED = env.E2E_UNSIGNED;
const OTHER = env.E2E_OTHER_SIGNED;
const EGRESS = env.E2E_EGRESS_UNSIGNED;
const docker = new Docker();
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'ok' : 'FAIL'}: ${label}${ok || detail === '' ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`,
  );
  if (!ok) failures++;
};

function payload(dropId, image, egress) {
  return {
    ...(egress ? { egress } : {}),
    protocol: 1,
    dropId,
    epoch: 1,
    role: 'review',
    repo: { owner, name, defaultBranch: env.E2E_BRANCH },
    issue: { number: 1, title: 'e2e', body: 'e2e' },
    branch: env.E2E_BRANCH,
    pr: { number: 1, branch: env.E2E_BRANCH, headSha: env.E2E_SHA },
    gates: [{ name: 'uid', run: 'id -u', timeoutMinutes: 2 }],
    model: 'm',
    maxTurns: 1,
    promptVersion: 'e2e',
    prompt: 'review',
    image,
    protectedPaths: [],
    credentials: { claudeToken: 'sk-ant-oat01-E2EDUMMYDUMMYDUMMYDUMMY' },
  };
}

function client() {
  return {
    result: undefined,
    async heartbeat() {
      return 'ok';
    },
    async postEvents() {
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

/** Counts what the driver creates, so a refusal is shown to create nothing. */
class CountingDriver extends DockerDriver {
  started = 0;
  async start(o) {
    this.started++;
    return super.start(o);
  }
}

async function drop(dropId, image, trust, o = {}) {
  const driver = new CountingDriver(docker);
  driver.networks = 0;
  const create = driver.createDropNetwork.bind(driver);
  driver.createDropNetwork = (...a) => {
    driver.networks++;
    return create(...a);
  };
  const c = client();
  const log = [];
  await runDrop(payload(dropId, image, o.egress), {
    client: c,
    driver,
    stickId: 'e2e-verify',
    trust,
    heartbeatMs: 60_000,
    log: (l) => log.push(l),
    ...(o.egressImage ? { egressImage: o.egressImage } : {}),
  });
  return {
    result: c.result,
    started: driver.started,
    networks: driver.networks,
    log: log.map((l) => JSON.parse(l)),
  };
}

const release = loadRelease();
check(
  'the stick image records its trusted repository',
  release?.repository === env.E2E_REPO,
  release,
);
const startup = (extra) =>
  prepareImageTrust(
    { ...env, ...extra },
    { cosign: execCosign('cosign', env), release, log: () => {} },
  );

// Startup refuses a tag pin under the signed policy.
let refused = '';
try {
  await startup({ JM_ALLOWED_IMAGES: 'jumpmaster-trooper:e2e' });
} catch (e) {
  refused = e.message;
}
check(
  'startup refuses a non-digest JM_ALLOWED_IMAGES entry',
  /JM_ALLOWED_IMAGES entry jumpmaster-trooper:e2e is not a digest reference/.test(refused),
  refused,
);

// The real startup: cosign is the pinned version, and the stick would advertise image-verify-v1.
const trust = await startup({ JM_ALLOWED_IMAGES: '' });
const caps = advertisedCapabilities({ egress: false, policy: trust.policy });
check(
  'startup passes with the shipped cosign and advertises image-verify-v1',
  caps.includes('image-verify-v1'),
  caps,
);

// 1. A tag is refused before any pull, cosign call or container.
const tag = await drop('verify-tag', 'jumpmaster-trooper:e2e', trust);
check(
  'a tag reference is refused, nothing created',
  /^image not verified: jumpmaster-trooper:e2e: a tag reference;/.test(tag.result?.reason ?? '') &&
    tag.started === 0,
  tag,
);

// 2. The unsigned local image, by digest (removed locally): refused by cosign against the registry,
// and never downloaded.
const before = await new DockerDriver(docker).imageExists(UNSIGNED);
const unsigned = await drop('verify-unsigned', UNSIGNED, trust);
const after = await new DockerDriver(docker).imageExists(UNSIGNED);
check('the unsigned image was missing before the drop', before === false, { before });
check(
  'the stick never downloaded it',
  after === false && !unsigned.log.some((l) => l.event === 'image-pull'),
  { after, log: unsigned.log },
);
// Refused because cosign found no signature, not because it couldn't reach Sigstore.
check(
  'an unsigned image is refused by cosign (no signature), nothing created',
  (unsigned.result?.reason ?? '').startsWith(`image not verified: ${UNSIGNED}: cosign exit `) &&
    /no signatures found|no matching signatures/.test(unsigned.result?.reason ?? '') &&
    unsigned.started === 0,
  unsigned,
);

console.log(`  reason: ${unsigned.result?.reason}`);

// 3. An image signed keyless, but by another identity (Sigstore's own cosign image): refused.
const other = await drop('verify-other', OTHER, trust);
// Refused on the certificate identity: the keyless check itself ran against Sigstore.
check(
  'an image signed by another identity is refused on its identity, nothing created',
  (other.result?.reason ?? '').startsWith(`image not verified: ${OTHER}: cosign exit `) &&
    /CertificateIdentity|expected SAN|no matching attestations|no matching signatures/.test(
      other.result?.reason ?? '',
    ) &&
    !/tuf|x509|certificate signed by unknown authority/i.test(other.result?.reason ?? '') &&
    other.started === 0,
  other,
);
check(
  'cosign keeps its Sigstore TUF root under /state',
  fs.existsSync('/state/sigstore'),
  fs.readdirSync('/state'),
);

console.log(`  reason: ${other.result?.reason}`);

// 4. The same unsigned image, pinned by digest: runs, and the log says how it was let through.
const pinned = await startup({ JM_ALLOWED_IMAGES: UNSIGNED });
const run = await drop('verify-pinned', UNSIGNED, pinned);
check(
  'the same image pinned by digest runs the drop',
  run.result?.status === 'completed' && run.result?.gates?.[0]?.outputTail?.trim() === '10002',
  run.result,
);
check(
  'once pinned, the stick pulled it by digest',
  (await new DockerDriver(docker).imageExists(UNSIGNED)) &&
    run.log.some((l) => l.event === 'image-pull' && l.ref === UNSIGNED && l.status === 'done'),
  run.log,
);
check(
  "it is logged as image-verified via: 'pinned'",
  run.log.some((l) => l.event === 'image-verified' && l.ref === UNSIGNED && l.via === 'pinned'),
  run.log,
);

// 5. Under egress the proxy image is verified and pulled like the trooper: unpinned and unsigned,
// the drop fails before any download, network, proxy or trooper; pinned, it runs through it.
const egress = { mode: 'enforce', allow: ['api.anthropic.com', 'github.com'] };
const proxyBefore = await new DockerDriver(docker).imageExists(EGRESS);
const unpinnedProxy = await drop('verify-egress-unsigned', UNSIGNED, pinned, {
  egress,
  egressImage: EGRESS,
});
check('the unsigned proxy image was missing before the drop', proxyBefore === false, {
  proxyBefore,
});
check(
  'an unsigned proxy image is refused before any download, network or container',
  (unpinnedProxy.result?.reason ?? '').startsWith(`image not verified: ${EGRESS}: cosign exit `) &&
    unpinnedProxy.networks === 0 &&
    unpinnedProxy.started === 0 &&
    !unpinnedProxy.log.some((l) => l.event === 'image-pull'),
  unpinnedProxy,
);
const both = await startup({ JM_ALLOWED_IMAGES: `${UNSIGNED},${EGRESS}`, JM_EGRESS_IMAGE: EGRESS });
const viaProxy = await drop('verify-egress-pinned', UNSIGNED, both, {
  egress,
  egressImage: EGRESS,
});
check(
  'with the proxy pinned too, the drop runs under egress',
  viaProxy.result?.status === 'completed' && viaProxy.networks === 1,
  viaProxy.result,
);
check(
  'the proxy image is logged as image-verified via pinned',
  viaProxy.log.some((l) => l.event === 'image-verified' && l.ref === EGRESS && l.via === 'pinned'),
  viaProxy.log,
);

// 6. Nothing was cached for a failure: the cache file holds no entry at all.
const cache = fs.existsSync('/state/verified.json')
  ? JSON.parse(fs.readFileSync('/state/verified.json', 'utf8'))
  : { entries: {} };
check('no failure was cached', Object.keys(cache.entries ?? {}).length === 0, cache);

console.log(failures === 0 ? 'verify e2e: pass' : `verify e2e: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
