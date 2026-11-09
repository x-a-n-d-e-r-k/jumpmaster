import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { type Config, loadConfig, secretList } from './config.js';
import { creditsPass } from './credits.js';
import { openDb } from './db/open.js';
import { ensureZoneMode } from './db/repo.js';
import { reconcileZone } from './flow/reconcile.js';
import { GitHubForge } from './forge/github.js';
import { leaseExpirer } from './leases.js';
import { type ForgePair, markPendingUnknown, pairFor } from './outbox.js';
import { promptVersions } from './payloads.js';
import { syncDropZone } from './sync.js';

/** How long one doctor read may take before it is abandoned. */
const DOCTOR_REQUEST_MS = 30_000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Redacts configured secrets from a message before it is logged. */
function scrub(msg: string, config: Config): string {
  return secretList(config.secrets).reduce((m, s) => m.split(s).join('[redacted]'), msg);
}

export async function start(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(configPath, env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'jumpmaster.sqlite'));
  // A write in flight when the process died has an unknown outcome: resolve it by read-back.
  markPendingUnknown(db, new Date());
  for (const zone of config.dropZones) ensureZoneMode(db, zone.id, zone.mode, new Date());

  const forges = new Map(
    config.dropZones.map((zone) => {
      return [zone.id, pairFor(zone, config.secrets)] as const;
    }),
  );
  const forgesFor = (zoneId: string): ForgePair => {
    const pair = forges.get(zoneId);
    if (!pair) throw new Error(`unknown drop zone ${zoneId}`);
    return pair;
  };
  const log = (msg: string) => console.error(`[jumpmaster] ${scrub(msg, config)}`);

  // The doctor's forge on the read token: reads only, never handed a write.
  const readToken = config.secrets.githubReadToken;
  const readForgeFor = (zoneId: string) => {
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone || !readToken) return undefined;
    const [owner = '', name = ''] = zone.repo.split('/');
    return new GitHubForge(owner, name, readToken, { requestTimeoutMs: DOCTOR_REQUEST_MS });
  };
  // The doctor's own forges: the same tokens, but every request is abandoned after a deadline, so
  // one stalled connection can't hang a run (the polling pass keeps its forges as they were).
  const doctorForges = new Map(
    config.dropZones.map(
      (zone) =>
        [zone.id, pairFor(zone, config.secrets, { requestTimeoutMs: DOCTOR_REQUEST_MS })] as const,
    ),
  );
  const doctorForgesFor = (zoneId: string): ForgePair => {
    const pair = doctorForges.get(zoneId);
    if (!pair) throw new Error(`unknown drop zone ${zoneId}`);
    return pair;
  };

  // A ruling starts a pass at once; `guardedPass` is defined below and only called after listen.
  const app = createApp({
    db,
    config,
    forgesFor,
    readForgeFor,
    doctorForgesFor,
    now: () => new Date(),
    kick: () => void guardedPass(),
    log,
  });

  const secrets = secretList(config.secrets);
  const expireLeases = leaseExpirer(db, config.usage);
  const pass = async () => {
    expireLeases(new Date());
    // Global, before any zone: credits rulings apply whatever a zone's mode (not while killed).
    try {
      creditsPass(db, new Date());
    } catch (e) {
      log(`credits step failed: ${errorMessage(e)}`);
    }
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
        expireLeases(new Date());
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
