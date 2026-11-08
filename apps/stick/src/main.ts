import { StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { reapOrphans, runDrop } from './runner.js';
import { joinToken, loadEnrollment, saveEnrollment, stateDir } from './state.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const client = new StickClient(serverUrl, token);
  if (!token || !stickId) {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    const enrolled = await client.enroll(joinToken(process.env), name, slots);
    stickId = enrolled.stickId;
    saveEnrollment(dir, { serverUrl, stickId, stickToken: enrolled.stickToken });
    console.log(`enrolled as ${stickId}`);
  }

  const driver = new DockerDriver();
  // Before leasing: kill troopers a previous run of this stick left behind.
  const reaped = await reapOrphans(driver, stickId);
  if (reaped.length > 0) console.log(`removed ${reaped.length} orphaned trooper container(s)`);
  let running = 0;
  for (;;) {
    if (running >= slots) {
      await sleep(500);
      continue;
    }
    try {
      const drop = await client.lease(slots - running);
      if (!drop) continue;
      running++;
      console.log(`drop ${drop.dropId} (epoch ${drop.epoch}) leased`);
      runDrop(drop, {
        client,
        driver,
        stickId,
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
      console.error(`lease error: ${e instanceof Error ? e.message : e}`);
      await sleep(5000);
    }
  }
}

// The entry point: always runs (the helpers it uses live in state.ts so tests can import them).
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
