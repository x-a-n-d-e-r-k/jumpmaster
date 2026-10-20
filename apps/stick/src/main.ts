import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { reapOrphans, runDrop } from './runner.js';

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
  const dir = join(homedir(), '.jumpmaster');
  const file = join(dir, 'stick.json');

  let token: string | undefined;
  let stickId: string | undefined;
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      serverUrl?: string;
      stickId?: string;
      stickToken?: string;
    };
    if (saved.serverUrl === serverUrl && saved.stickId && saved.stickToken) {
      token = saved.stickToken;
      stickId = saved.stickId;
    }
  }
  const client = new StickClient(serverUrl, token);
  if (!token || !stickId) {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    const enrolled = await client.enroll(need('JM_JOIN_TOKEN'), name, slots);
    stickId = enrolled.stickId;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ serverUrl, stickId, stickToken: enrolled.stickToken }), {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
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
      runDrop(drop, { client, driver, stickId, heartbeatMs: 15_000 })
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
