import { leaseLogger, StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { egressCapability } from './egress.js';
import { createPushLoop, PendingPushes, PUSH_LOOP_MS, pushOnce } from './push.js';
import {
  reapOrphans,
  rediscoverPending,
  runDrop,
  sweepDropNetworks,
  sweepVolumes,
  TROOPER_IMAGE,
  type VolumeHealth,
  volumeSelfCheck,
} from './runner.js';
import {
  advertisedCapabilities,
  joinToken,
  leaseTerms,
  loadEnrollment,
  loadRelease,
  saveEnrollment,
  stateDir,
  stickInfo,
  stickVersion,
} from './state.js';
import { execCosign, prepareImageTrust } from './verify.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SWEEP_MS = 10 * 60_000;
/** How long a stick below the free floor waits before it looks again (the sweep re-measures). */
const FLOOR_WAIT_MS = 30_000;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const serverUrl = need('JM_SERVER_URL');
  const slots = Number(process.env.JM_SLOTS ?? '1');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('JM_SLOTS must be an integer >= 1');
  const dir = stateDir(process.env);
  const saved = loadEnrollment(dir, serverUrl);
  const token = saved?.stickToken;
  let stickId = saved?.stickId;
  const driver = new DockerDriver();
  const release = loadRelease();
  // Under the signed policy this refuses to start (with the reason) unless cosign is the pinned
  // version, every pin is a digest and there is a trusted signer.
  // The trooper image the stick runs its own containers from is verified and pulled first.
  const trust = await prepareImageTrust(process.env, {
    cosign: execCosign('cosign', process.env),
    ...(release ? { release } : {}),
    log: (line) => console.log(line),
    base: { image: TROOPER_IMAGE, driver },
  });
  // Advertised only when this engine really can enforce it; the server then never leases this
  // stick a drop from a zone that restricts egress.
  const egress = await egressCapability(driver, process.env, {
    trust,
    log: (line) => console.log(line),
  });
  if (!egress.ok) console.log(`egress-v1 not advertised: ${egress.reason}`);
  const info = {
    // push-v1 is not proved yet: each lease carries the latest check's capabilities.
    ...stickInfo(
      process.env,
      stickVersion(release),
      advertisedCapabilities({ egress: egress.ok, policy: trust.policy }),
    ),
    // Under signed the pins are exactly what verification lets through unsigned.
    ...(trust.policy === 'signed' ? { pinnedImages: [...trust.allowed].sort() } : {}),
  };
  console.log(
    `stick ${info.version}: image policy ${info.imagePolicy}, capabilities ${info.capabilities.join(', ') || 'none'}`,
  );
  const client = new StickClient(serverUrl, token, { info });
  const leaseLog = leaseLogger((line) => console.error(line));
  if (!token || !stickId) {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    const enrolled = await client.enroll(joinToken(process.env), name, slots);
    stickId = enrolled.stickId;
    saveEnrollment(dir, { serverUrl, stickId, stickToken: enrolled.stickToken });
    console.log(`enrolled as ${stickId}`);
  }

  // Before leasing: kill troopers a previous run of this stick left behind.
  const reaped = await reapOrphans(driver, stickId);
  if (reaped.removed.length > 0)
    console.log(`removed ${reaped.removed.length} orphaned trooper container(s)`);
  const id = stickId;
  const pending = new PendingPushes();
  // Volumes: the self-check at startup and in every sweep; push-v1 follows the latest result.
  let health: VolumeHealth = { selfCheck: false, freeBytes: null };
  const leaseTermsNow = () =>
    leaseTerms({ egress: egress.ok, policy: trust.policy, health, pending: pending.size() });
  const checkVolumes = async () => {
    health = await volumeSelfCheck(driver, TROOPER_IMAGE, id);
    if (!health.selfCheck) console.log('push-v1 not advertised: the volume self-check failed');
    if (health.freeBytes === null) console.log('free space could not be measured: not leasing');
    else if (!leaseTermsNow())
      console.log(`free space ${health.freeBytes} bytes is below the floor: not leasing`);
  };
  // Only once every orphan is confirmed gone are its volumes asked about (Ruling 14); otherwise
  // the sweep does it, container by container.
  if (reaped.unconfirmed.length > 0)
    console.log(
      `${reaped.unconfirmed.length} orphaned container(s) not confirmed removed: rediscovery waits for the sweep`,
    );
  else await rediscoverPending(driver, client, id, pending);
  if (pending.size() > 0) console.log(`rediscovered ${pending.size()} pending push(es)`);
  await checkVolumes();
  const active = new Set<string>();
  /** `dropId:epoch` of every drop in a lease slot: the sweep leaves their volumes alone. */
  const live = new Set<string>();
  // Pending pushes run in their own loop, never in a lease slot (Ruling 15).
  const pushLoop = createPushLoop(pending, (entry) =>
    pushOnce(entry, { client, driver, stickId: id, image: TROOPER_IMAGE, pending }),
  );
  setInterval(() => void pushLoop.tick(), PUSH_LOOP_MS);
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    (async () => {
      await checkVolumes();
      await sweepVolumes(driver, client, id, pending, live).catch(() => {});
      const n = await sweepDropNetworks(driver, id, new Set([...active, ...pending.networks()]));
      if (n > 0) console.log(`removed ${n} leaked drop network(s)`);
    })()
      .catch(() => {})
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_MS).unref();
  let running = 0;
  for (;;) {
    if (running >= slots) {
      await sleep(500);
      continue;
    }
    const terms = leaseTermsNow();
    if (!terms) {
      await sleep(FLOOR_WAIT_MS);
      continue;
    }
    try {
      const { drop, skipped } = await client.lease(slots - running, terms);
      leaseLog.skipped(skipped);
      if (!drop) continue;
      running++;
      const key = `${drop.dropId}:${drop.epoch}`;
      live.add(key);
      console.log(`drop ${drop.dropId} (epoch ${drop.epoch}) leased`);
      runDrop(drop, {
        client,
        driver,
        stickId,
        active,
        trust,
        pending,
        trooperImage: TROOPER_IMAGE,
        heartbeatMs: 15_000,
        ...(process.env.JM_LOST_SERVER_KILL_BEATS
          ? { lostServerKillBeats: Number(process.env.JM_LOST_SERVER_KILL_BEATS) }
          : {}),
      })
        .catch((e) =>
          console.error(`drop ${drop.dropId} failed: ${e instanceof Error ? e.message : e}`),
        )
        .finally(() => {
          live.delete(key);
          running--;
        });
    } catch (e) {
      leaseLog.error(e instanceof Error ? e.message : String(e));
      await sleep(5000);
    }
  }
}

// The entry point: always runs (the helpers it uses live in state.ts so tests can import them).
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
