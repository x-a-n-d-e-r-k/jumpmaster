import { leaseLogger, StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { egressCapability } from './egress.js';
import { reapOrphans, runDrop, sweepDropNetworks } from './runner.js';
import {
  advertisedCapabilities,
  joinToken,
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
  const trust = await prepareImageTrust(process.env, {
    cosign: execCosign('cosign', process.env),
    ...(release ? { release } : {}),
    log: (line) => console.log(line),
  });
  // Advertised only when this engine really can enforce it; the server then never leases this
  // stick a drop from a zone that restricts egress.
  const egress = await egressCapability(driver, process.env, {
    trust,
    log: (line) => console.log(line),
  });
  if (!egress.ok) console.log(`egress-v1 not advertised: ${egress.reason}`);
  const capabilities = advertisedCapabilities({ egress: egress.ok, policy: trust.policy });
  const info = {
    ...stickInfo(process.env, stickVersion(release), capabilities),
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
  if (reaped.length > 0) console.log(`removed ${reaped.length} orphaned trooper container(s)`);
  const active = new Set<string>();
  const id = stickId;
  setInterval(() => {
    sweepDropNetworks(driver, id, active)
      .then((n) => {
        if (n > 0) console.log(`removed ${n} leaked drop network(s)`);
      })
      .catch(() => {});
  }, SWEEP_MS).unref();
  let running = 0;
  for (;;) {
    if (running >= slots) {
      await sleep(500);
      continue;
    }
    try {
      const { drop, skipped } = await client.lease(slots - running);
      leaseLog.skipped(skipped);
      if (!drop) continue;
      running++;
      console.log(`drop ${drop.dropId} (epoch ${drop.epoch}) leased`);
      runDrop(drop, {
        client,
        driver,
        stickId,
        active,
        trust,
        heartbeatMs: 15_000,
        ...(process.env.JM_LOST_SERVER_KILL_BEATS
          ? { lostServerKillBeats: Number(process.env.JM_LOST_SERVER_KILL_BEATS) }
          : {}),
      })
        .catch((e) =>
          console.error(`drop ${drop.dropId} failed: ${e instanceof Error ? e.message : e}`),
        )
        .finally(() => {
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
