import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StickClient } from './client.js';
import { DockerDriver } from './docker.js';
import { runDrop } from './runner.js';

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
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      serverUrl?: string;
      stickToken?: string;
    };
    if (saved.serverUrl === serverUrl) token = saved.stickToken;
  }
  const client = new StickClient(serverUrl, token);
  if (!token) {
    const name = process.env.JM_STICK_NAME ?? 'stick';
    const { stickId, stickToken } = await client.enroll(need('JM_JOIN_TOKEN'), name, slots);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ serverUrl, stickId, stickToken }), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`enrolled as ${stickId}`);
  }

  const driver = new DockerDriver();
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
      runDrop(drop, { client, driver, heartbeatMs: 15_000 })
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
