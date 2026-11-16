import { leaseLogger, StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { egressCapability } from './egress.js';
import { stickPlatform } from './fetch-image.js';
import { imageSource } from './pull.js';
import { createPushLoop, PendingPushes, PUSH_LOOP_MS, pushOnce } from './push.js';
import {
  HealthMonitor,
  recoverAtStartup,
  runDrop,
  sweepDropNetworks,
  sweepVolumes,
  TROOPER_IMAGE,
} from './runner.js';
import { enrolledSlots, maxSlotsFor, SlotTarget } from './slots.js';
import {
  advertisedCapabilities,
  enrollCredential,
  healthLine,
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
/** How long a stick below the free floor waits between re-measurements. */
const FLOOR_WAIT_MS = 30_000;
/** How often a full stick asks the server (with no free slot) whether its trooper count changed. */
const SLOTS_POLL_MS = 10_000;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const serverUrl = need('JM_SERVER_URL');
  // JM_SLOTS is the count asked for at enrollment; the server's count (capped here) wins after.
  const slots = enrolledSlots(process.env);
  const maxSlots = maxSlotsFor(process.env, slots);
  const target = new SlotTarget(slots, maxSlots);
  const dir = stateDir(process.env);
  const saved = loadEnrollment(dir, serverUrl);
  const token = saved?.stickToken;
  let stickId = saved?.stickId;
  const driver = new DockerDriver();
  const release = loadRelease();
  // Under the signed policy this refuses to start (with the reason) unless cosign is the pinned
  // version, every pin is a digest and there is a trusted signer. The trooper image is verified
  // with the health check below: a refused one withholds push-v1, never startup.
  const trust = await prepareImageTrust(process.env, {
    cosign: execCosign('cosign', process.env),
    ...(release ? { release } : {}),
    log: (line) => console.log(line),
  });
  const client = new StickClient(serverUrl, token, { maxSlots, slots });
  let enrolled = Boolean(token && stickId);
  const enroll = async () => {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    // A one-time code (the installer's, issue #138) names the stick from its invite.
    const out = await client.enroll(enrollCredential(process.env), name, slots);
    stickId = out.stickId;
    enrolled = true;
    saveEnrollment(dir, { serverUrl, stickId, stickToken: out.stickToken });
    // The installer waits for this line, and prints the name.
    console.log(`enrolled as ${out.name ?? name} (${stickId})`);
  };
  // Where missing images come from (issue #141): JM_IMAGE_SOURCE, else the server once it
  // announces image-mirror-v1 on a lease. Checked here, so a bad value stops the start.
  imageSource(process.env, undefined);
  trust.server = {
    source: () => imageSource(process.env, client.features),
    deps: {
      client,
      loader: driver,
      stateDir: dir,
      platform: stickPlatform(),
      log: (line) => console.log(line),
    },
  };
  if (imageSource(process.env, undefined) === 'server') {
    console.log(`images: from the server, for ${stickPlatform()}`);
    // The proxy image below comes from the server, which needs the stick token: enroll first,
    // advertising what is known so far (every lease advertises the rest).
    if (!enrolled) {
      client.advertise(
        stickInfo(
          process.env,
          stickVersion(release),
          advertisedCapabilities({ egress: false, policy: trust.policy }),
        ),
      );
      await enroll();
    }
  }
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
  client.advertise(info);
  console.log(`troopers: ${target.target} at once to start, at most ${maxSlots}`);
  const leaseLog = leaseLogger((line) => console.error(line));
  if (!enrolled) await enroll();

  if (!stickId) throw new Error('not enrolled');
  const id: string = stickId;
  const pending = new PendingPushes();
  // Before leasing: kill troopers a previous run of this stick left behind, then rediscover its
  // pending pushes, each volume once its own drop's containers are confirmed gone (Ruling 14).
  const reaped = await recoverAtStartup(driver, client, id, pending);
  if (reaped.removed.length > 0)
    console.log(`removed ${reaped.removed.length} orphaned trooper container(s)`);
  if (reaped.unconfirmed.length > 0)
    console.log(
      `${reaped.unconfirmed.length} orphaned container(s) not confirmed removed: their drops' volumes wait for the sweep`,
    );
  if (pending.size() > 0) console.log(`rediscovered ${pending.size()} pending push(es)`);
  // Health: the base image and the volume self-check, at startup, in every sweep and in each
  // wait below the floor; push-v1 follows the latest result.
  const health = new HealthMonitor(driver, {
    image: TROOPER_IMAGE,
    stickId: id,
    trust,
    log: (line) => console.error(line),
  });
  // Reported on every lease for the sticks page (issue #138), with the latest free space.
  const docker = (await driver.engineVersion().catch(() => '')).slice(0, 64) || 'unknown';
  const leaseTermsNow = () => {
    const terms = leaseTerms({
      egress: egress.ok,
      policy: trust.policy,
      health: health.latest(),
      pending: pending.size(),
    });
    return terms && { ...terms, health: { docker, freeBytes: health.latest().freeBytes } };
  };
  let lastState = '';
  const checkVolumes = async (): Promise<void> => {
    const state = healthLine(await health.check());
    // Logged when it changes, not on every re-check.
    if (state !== lastState) console.log(state);
    lastState = state;
  };
  await checkVolumes();
  const active = new Set<string>();
  /** `dropId:epoch` of every drop in a lease slot: the sweep leaves their volumes alone. */
  const live = new Set<string>();
  // Pending pushes run in their own loop, never in a lease slot (Ruling 15).
  // No push container runs from a base image the latest check refused: entries wait, queued.
  const pushLoop = createPushLoop(
    pending,
    (entry) => pushOnce(entry, { client, driver, stickId: id, image: TROOPER_IMAGE, pending }),
    { ready: () => health.latest().base.ok },
  );
  setInterval(() => void pushLoop.tick(), PUSH_LOOP_MS);
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    (async () => {
      await checkVolumes();
      await sweepVolumes(driver, client, id, pending, live, undefined, {
        selfCheckBusy: () => health.busy(),
      }).catch(() => {});
      const n = await sweepDropNetworks(driver, id, new Set([...active, ...pending.networks()]));
      if (n > 0) console.log(`removed ${n} leaked drop network(s)`);
    })()
      .catch(() => {})
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_MS).unref();
  let running = 0;
  let asked = 0;
  /** Applies the server's trooper count, saying so when the target moves. */
  const follow = (told: number | null) => {
    const before = target.target;
    target.follow(told);
    asked = Date.now();
    if (target.target !== before) console.log(`troopers: now ${target.target} at once`);
  };
  for (;;) {
    if (target.free(running) < 1) {
      // Full: nothing running is stopped. Ask now and then, with no free slot, whether the count
      // went up, so a raise applies before a drop finishes.
      const terms = leaseTermsNow();
      if (terms && Date.now() - asked >= SLOTS_POLL_MS) {
        try {
          follow((await client.lease(0, terms)).slots);
        } catch (e) {
          asked = Date.now();
          leaseLog.error(e instanceof Error ? e.message : String(e));
        }
      }
      await sleep(500);
      continue;
    }
    if (!leaseTermsNow()) {
      // Measured below the floor: look again now, so leasing resumes once space is freed.
      await checkVolumes().catch(() => {});
      if (!leaseTermsNow()) await sleep(FLOOR_WAIT_MS);
      continue;
    }
    const terms = leaseTermsNow();
    if (!terms) continue;
    try {
      const { drop, skipped, slots: told } = await client.lease(target.free(running), terms);
      follow(told);
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
        baseImage: () => health.latest().base,
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
