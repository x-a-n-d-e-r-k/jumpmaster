import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SetupMode, setupActive, setupCodeLine } from './auth/operator.js';
import { configPathOf, loadBoot } from './config/boot.js';
import { ConfigStore } from './config/store.js';
import { type Config, secretList, startupWarnings } from './config.js';
import { creditsPass } from './credits.js';
import { openDb } from './db/open.js';
import { reconcileZone } from './flow/reconcile.js';
import { GitHubForge } from './forge/github.js';
import { leaseExpirer } from './leases.js';
import { type ForgePair, ForgePairs, markPendingUnknown } from './outbox.js';
import { promptVersions } from './payloads.js';
import { syncDropZone } from './sync.js';

/** How long one request on the timed forges (doctor reads, intake writes) may take. */
const TIMED_REQUEST_MS = 30_000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Redacts configured secrets from a message before it is logged. */
function scrub(msg: string, config: Config | undefined): string {
  if (!config) return msg;
  return secretList(config.secrets).reduce((m, s) => m.split(s).join('[redacted]'), msg);
}

type Timers = {
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
};
const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/**
 * The poll timer, re-armed whenever an applied revision changes `pollSeconds`: the only consumer
 * that is not read at the top of a pass, since it decides when the pass runs.
 */
export function pollTimer(
  source: {
    current(): { pollSeconds: number };
    subscribe(fn: (c: { pollSeconds: number }) => void): () => void;
  },
  run: () => void,
  timers: Timers = realTimers,
): { stop(): void } {
  let seconds = source.current().pollSeconds;
  let handle = timers.setInterval(run, seconds * 1000);
  const off = source.subscribe((c) => {
    if (c.pollSeconds === seconds) return;
    seconds = c.pollSeconds;
    timers.clearInterval(handle);
    handle = timers.setInterval(run, seconds * 1000);
  });
  return {
    stop() {
      off();
      timers.clearInterval(handle);
    },
  };
}

/**
 * Starts the server. `configPath` (or `JM_CONFIG`) names the config file; absent or missing, the
 * install keeps its config in the database (db mode) and its boot settings in the environment.
 */
export async function start(configPath?: string, env: NodeJS.ProcessEnv = process.env) {
  const filePath = configPathOf(env, configPath);
  const boot = loadBoot(env, filePath);
  mkdirSync(boot.dataDir, { recursive: true });
  const db = openDb(join(boot.dataDir, 'jumpmaster.sqlite'));
  // A write in flight when the process died has an unknown outcome: resolve it by read-back.
  markPendingUnknown(db, new Date());

  let store: ConfigStore | undefined;
  const log = (msg: string) => console.error(`[jumpmaster] ${scrub(msg, store?.current())}`);
  try {
    store = ConfigStore.open({
      db,
      boot,
      ...(filePath ? { filePath } : {}),
      env,
      now: () => new Date(),
      log,
    });
  } catch (e) {
    db.close();
    throw e;
  }
  const live = store;
  // Risky settings are said out loud at every start (starter mode's merge-any-green-PR residual),
  // and again when a revision makes a zone starter.
  let warned = new Set(startupWarnings(live.current()));
  for (const w of warned) log(`warning: ${w}`);
  live.subscribe((c) => {
    const now = new Set(startupWarnings(c));
    for (const w of now) if (!warned.has(w)) log(`warning: ${w}`);
    warned = now;
  });

  // Forge pairs are built from the config as it is when they are asked for, and rebuilt only
  // when the zone's repository, identity or credentials change.
  const pairs = new ForgePairs();
  const pairOf = (zoneId: string, opts: { requestTimeoutMs?: number } = {}): ForgePair => {
    const config = live.current();
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone) throw new Error(`unknown drop zone ${zoneId}`);
    return pairs.for(zone, config.secrets, opts);
  };
  const forgesFor = (zoneId: string): ForgePair => pairOf(zoneId);

  // The doctor's forge on the read token: reads only, never handed a write.
  const readForgeFor = (zoneId: string) => {
    const config = live.current();
    const readToken = config.secrets.githubReadToken;
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone || !readToken) return undefined;
    const [owner = '', name = ''] = zone.repo.split('/');
    return new GitHubForge(owner, name, readToken, { requestTimeoutMs: TIMED_REQUEST_MS });
  };
  // Timed forges: the zone's tokens again, but every request is abandoned after a deadline, so one
  // stalled connection can't hang a request handler (the polling pass keeps its forges as they
  // were). Two users, with different contracts:
  // - the doctor only reads through them (it never writes: `doctorForgesFor`);
  // - the intake writes through them, behind the operator token and the outbox, so a stalled forge
  //   answers 502 instead of hanging the browser (`intakeForgesFor`).
  const timedForgesFor = (zoneId: string): ForgePair =>
    pairOf(zoneId, { requestTimeoutMs: TIMED_REQUEST_MS });
  const doctorForgesFor = timedForgesFor;
  const intakeForgesFor = timedForgesFor;

  // The setup code goes to stderr alone on its line, unscrubbed and unprefixed (it is no
  // configured secret), naming the port actually bound.
  let bound = { host: boot.listen.host, port: boot.listen.port };
  const setup = new SetupMode((code) => process.stderr.write(`${setupCodeLine(code, bound)}\n`));

  // A ruling starts a pass at once; `guardedPass` is defined below and only called after listen.
  const app = createApp({
    setup,
    db,
    config: live,
    forgesFor,
    readForgeFor,
    doctorForgesFor,
    intakeForgesFor,
    now: () => new Date(),
    kick: () => void guardedPass(),
    log,
  });

  const expireLeases = leaseExpirer(db, () => live.current().usage);
  // One config per pass, read at its start: a revision applied mid-pass is the next pass's. A
  // running drop keeps the payload it was leased with.
  const pass = async () => {
    const config = live.current();
    const secrets = secretList(config.secrets);
    expireLeases(new Date());
    // Global, before any zone: credits rulings apply whatever a zone's mode (not while killed).
    try {
      creditsPass(db, new Date());
    } catch (e) {
      log(`credits step failed: ${errorMessage(e)}`);
    }
    for (const zone of config.dropZones) {
      try {
        const forgePair = pairs.for(zone, config.secrets);
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

  const poll = pollTimer(live, () => void guardedPass());
  const leaseTimer = setInterval(() => {
    try {
      expireLeases(new Date());
    } catch (e) {
      log(`lease expiry failed: ${errorMessage(e)}`);
    }
  }, 10_000);

  await app.listen({ host: boot.listen.host, port: boot.listen.port });
  const address = app.server.address();
  if (address && typeof address === 'object') bound = { ...bound, port: address.port };
  log(`listening on ${boot.listen.host}:${bound.port} (config: ${live.mode()} mode)`);
  // No operator yet: one setup code per start (§7.5), printed once the URL it names answers.
  if (setupActive(db)) setup.rotateSetupCode();
  void guardedPass();

  return {
    app,
    store: live,
    async stop() {
      poll.stop();
      clearInterval(leaseTimer);
      await app.close();
      db.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start(process.argv[2]).then(
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
