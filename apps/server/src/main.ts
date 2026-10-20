import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { type Config, loadConfig, secretList } from './config.js';
import { openDb } from './db/open.js';
import { reconcileZone } from './flow/reconcile.js';
import { GitHubForge } from './forge/github.js';
import { expireLeases } from './leases.js';
import { type ForgePair, markPendingUnknown } from './outbox.js';
import { promptVersions } from './payloads.js';
import { syncDropZone } from './sync.js';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Redacts configured secrets from a message before it is logged. */
function scrub(msg: string, config: Config): string {
  return Object.values(config.secrets).reduce(
    (m, s) => (s ? m.split(s).join('[redacted]') : m),
    msg,
  );
}

export async function start(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(configPath, env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'jumpmaster.sqlite'));
  // A write in flight when the process died has an unknown outcome: resolve it by read-back.
  markPendingUnknown(db, new Date());

  const forges = new Map(
    config.dropZones.map((zone) => {
      const [owner = '', name = ''] = zone.repo.split('/');
      const pair: ForgePair = {
        author: new GitHubForge(owner, name, config.secrets.githubAuthorToken),
        reviewer: new GitHubForge(owner, name, config.secrets.githubReviewerToken),
      };
      return [zone.id, pair] as const;
    }),
  );
  const forgesFor = (zoneId: string): ForgePair => {
    const pair = forges.get(zoneId);
    if (!pair) throw new Error(`unknown drop zone ${zoneId}`);
    return pair;
  };
  const log = (msg: string) => console.error(`[jumpmaster] ${scrub(msg, config)}`);

  const app = createApp({ db, config, forgesFor, now: () => new Date() });

  const secrets = secretList(config.secrets);
  const pass = async () => {
    expireLeases(db, new Date(), config.usage);
    for (const zone of config.dropZones) {
      try {
        const forgePair = forgesFor(zone.id);
        const synced = await syncDropZone(db, forgePair, zone, new Date());
        await reconcileZone(
          db,
          forgePair,
          zone,
          synced.pass,
          promptVersions(),
          config.usage,
          secrets,
          new Date(),
        );
      } catch (e) {
        log(`pass failed for zone ${zone.id}: ${errorMessage(e)}`);
      }
    }
  };
  let passRunning = false;
  const guardedPass = async () => {
    if (passRunning) return;
    passRunning = true;
    try {
      await pass();
    } catch (e) {
      log(`poll pass failed: ${errorMessage(e)}`);
    } finally {
      passRunning = false;
    }
  };

  const timers = [
    setInterval(() => void guardedPass(), config.pollSeconds * 1000),
    setInterval(() => {
      try {
        expireLeases(db, new Date(), config.usage);
      } catch (e) {
        log(`lease expiry failed: ${errorMessage(e)}`);
      }
    }, 10_000),
  ];

  await app.listen({ host: config.listen.host, port: config.listen.port });
  log(`listening on ${config.listen.host}:${config.listen.port}`);
  void guardedPass();

  return {
    app,
    async stop() {
      for (const t of timers) clearInterval(t);
      await app.close();
      db.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('usage: node dist/main.js <configPath>');
    process.exit(2);
  }
  start(configPath).then(
    (srv) => {
      const shutdown = () => void srv.stop().finally(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
    (e) => {
      console.error(`[jumpmaster] fatal: ${errorMessage(e)}`);
      process.exit(1);
    },
  );
}
