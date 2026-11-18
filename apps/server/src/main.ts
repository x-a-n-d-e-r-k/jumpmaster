import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SetupMode, setupActive, setupCodeLine } from './auth/operator.js';
import { configPathOf, loadBoot } from './config/boot.js';
import { ConfigStore, startVault } from './config/store.js';
import {
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  preflightSecrets,
  secretList,
  startupWarnings,
} from './config.js';
import { creditsPass } from './credits.js';
import { openDb } from './db/open.js';
import { reconcileZone } from './flow/reconcile.js';
import { createAppBrokers } from './forge/app-brokers.js';
import { createAppTokenSource } from './forge/app-tokens.js';
import { createHeldDropTokens } from './forge/held-tokens.js';
import { appRefusal } from './forge/installation-verifier.js';
import { makeReadForgeFor, TIMED_REQUEST_MS } from './forge/read-forge.js';
import { serverScrubSet } from './forge/scrub-set.js';
import { imageLockPath, startImageMirror } from './images/run.js';
import { leaseExpirer } from './leases.js';
import { log as serverLog, setLogSource, writeLog } from './log.js';
import { type ForgePair, ForgePairs, markPendingUnknown, pairOptionsFor } from './outbox.js';
import { promptVersions } from './payloads.js';
import { zonePass } from './scheduler.js';
import { readSecretFile } from './secrets.js';
import { recordPass } from './status.js';
import { syncDropZone } from './sync.js';
import { transcriptPruner } from './transcripts.js';
import { credentialProblems } from './vault/problems.js';
import { sweepStopping } from './zones/stop.js';

/**
 * The startup line. On 0.0.0.0 the server is inside a container (compose's default), where that
 * address is not the one to open: compose publishes the port on the address compose.yaml names.
 */
export function listeningLine(host: string, port: number, mode: string): string {
  return host === '0.0.0.0'
    ? `listening on ${host}:${port} inside the container (config: ${mode} mode); compose publishes it on the address in compose.yaml`
    : `listening on ${host}:${port} (config: ${mode} mode)`;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Timers = {
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
};
const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/**
 * The interval for `pollSeconds`, clamped to the schema's bounds whatever reaches it: above
 * 2^31-1 ms `setInterval` fires every millisecond, and a sub-second value is a busy loop.
 */
function pollMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60_000;
  return Math.min(Math.max(seconds, MIN_POLL_SECONDS), MAX_POLL_SECONDS) * 1000;
}

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
  let handle = timers.setInterval(run, pollMs(seconds));
  const off = source.subscribe((c) => {
    if (c.pollSeconds === seconds) return;
    seconds = c.pollSeconds;
    timers.clearInterval(handle);
    handle = timers.setInterval(run, pollMs(seconds));
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
  // An unreadable secret file (a variable's, one named under the secrets directory, or the vault
  // key) is named before the data directory or the database is touched.
  preflightSecrets(env, boot.secretsDir);
  if (env.JM_VAULT_KEY_FILE) readSecretFile(env.JM_VAULT_KEY_FILE, 'JM_VAULT_KEY_FILE');
  mkdirSync(boot.dataDir, { recursive: true });
  const db = openDb(join(boot.dataDir, 'jumpmaster.sqlite'));
  // A write in flight when the process died has an unknown outcome: resolve it by read-back.
  markPendingUnknown(db, new Date());

  let store: ConfigStore | undefined;
  const log = (msg: string) => writeLog(msg, store?.current(), store?.retired());
  try {
    // The key and the data travel together: a non-empty vault without its key stops the start.
    // JM_VAULT_KEY_FILE wins; else the key file Settings wrote when it turned the vault on.
    const vault = startVault(env, db, boot.dataDir);
    store = ConfigStore.open({
      db,
      boot,
      ...(filePath ? { filePath } : {}),
      env,
      vault,
      now: () => new Date(),
      log,
    });
  } catch (e) {
    db.close();
    throw e;
  }
  const live = store;
  // Writers with no store of their own (sync, the crew schedule, the image mirror) log through
  // the module-level `log`: it scrubs against this store's config and retired values.
  const unsetLogSource = setLogSource(live);
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
  // A removed zone (drained first) gives up its forge pairs with the revision that removes it.
  live.subscribe((c) => pairs.retain(c.dropZones.map((z) => z.id)));
  const pairOf = (zoneId: string, opts: { requestTimeoutMs?: number } = {}): ForgePair => {
    const config = live.current();
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone) throw new Error(`unknown drop zone ${zoneId}`);
    return pairs.for(zone, config.secrets, { ...opts, ...pairOptionsOf(zone) });
  };
  const forgesFor = (zoneId: string): ForgePair => pairOf(zoneId);

  // The server's GitHub App tokens (§4.2): one process-wide cache, nothing called until a token is
  // asked for, every JWT and token in the scrub set before use.
  const appTokens = createAppTokenSource({
    resolvedApps: () => live.resolvedApps(),
    zones: () => live.current().dropZones,
    now: Date.now,
    add: (s) => serverScrubSet.add(s),
  });
  // A zone's pair options (spec §4.3, §4.4): a role that resolves to an app acts as that app, on
  // its server-use tokens, identity and installation grant; a PAT role on its PAT. The push grant
  // (issue #292, D1 and D5) is an app author's narrowed `push` token, minted per write, or the
  // author PAT in PAT mode. Never a wider token for the server's branch update.
  function pairOptionsOf(zone: Parameters<typeof pairOptionsFor>[0]) {
    return pairOptionsFor(
      zone,
      { resolved: live.resolved(), apps: live.resolvedApps() },
      appTokens,
    );
  }
  // A revision that replaces, swaps, adds or drops an app entry empties the token cache (issue #266).
  live.onAppsChanged(() => appTokens.clear());
  // The push containers' tokens in app mode (§4.2, issue #224): one broker per owner and role,
  // every key, JWT and token in the scrub set before use.
  // They verify a zone's recorded ids with the token source's check (issue #267): one cache.
  const appBrokers = createAppBrokers({ apps: () => live.resolvedApps(), verifier: appTokens });
  // The review, crew and doctor drops' clone tokens in app mode (§4.2, issue #237): minted per
  // drop, held in memory, revoked when the drop ends (the lease tick sweeps the ended ones).
  const heldReadTokens = createHeldDropTokens({ log });
  // The doctor's forge on the read token (or, with none, the reviewer app's contents: read token):
  // reads only, never handed a write.
  const readForgeFor = makeReadForgeFor(live, appTokens);
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

  // The release images, mirrored for sticks in the background (issue #140): from the lock only,
  // with the registry read token when the registry refuses anonymous access.
  const images = startImageMirror({
    dataDir: boot.dataDir,
    lockPath: imageLockPath(env),
    token: () => live.current().secrets.registryReadToken,
    log,
  });

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
    images: images.mirror,
    appBrokers,
    appTokens,
    installationVerifier: appTokens,
    heldReadTokens,
    resolvedApps: () => live.resolvedApps(),
    // The kill switch suspends each zone's app installations, and release unsuspends them (§4.2).
    appSuspension: {
      apps: () => live.resolvedApps(),
      brokerFor: (owner, role) => appBrokers.brokerFor(owner, role),
    },
  });

  const expireLeases = leaseExpirer(db, () => live.current().usage);
  // A zone the operator stopped managing is removed once drained, even when asked before a restart.
  // A refusal that repeats every tick is said once, until it changes.
  let lastRefusal = '';
  const onceLog = (msg: string) => {
    if (msg !== lastRefusal) log(msg);
    lastRefusal = msg;
  };
  const sweepStops = () => {
    try {
      for (const id of sweepStopping(db, live, new Date(), onceLog))
        log(`zone ${id} drained and removed (stopped managing)`);
    } catch (e) {
      log(`stopping sweep failed: ${errorMessage(e)}`);
    }
  };
  sweepStops();
  // One config per pass, read at its start: a revision applied mid-pass is the next pass's. A
  // running drop keeps the payload it was leased with.
  const pass = async () => {
    sweepStops();
    const config = live.current();
    const secrets = secretList(config.secrets);
    expireLeases(new Date());
    // Global, before any zone: credits rulings apply whatever a zone's mode (not while killed).
    try {
      creditsPass(db, new Date());
    } catch (e) {
      log(`credits step failed: ${errorMessage(e)}`);
    }
    const resolved = live.resolved();
    for (const zone of config.dropZones) {
      try {
        // A zone with a credential problem is parked with it as the reason (vault/problems.ts),
        // and so is one whose recorded app ids GitHub refuses (issue #267).
        await zonePass(
          zone,
          credentialProblems(zone, resolved, live.resolvedApps()),
          async () => {
            const forgePair = pairs.for(zone, config.secrets, pairOptionsOf(zone));
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
              // A triage drop's issue images: the read token goes to github.com only.
              {
                fetch: globalThis.fetch,
                ...(config.secrets.githubReadToken
                  ? { token: config.secrets.githubReadToken }
                  : {}),
              },
            );
          },
          log,
          // A zone whose recorded app ids GitHub refuses is parked too (issue #267).
          () => appRefusal(appTokens, zone, live.resolvedApps()),
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
      // The status line compares the doctor's last run with this, across restarts too.
      recordPass(db, new Date());
    } catch (e) {
      log(`poll pass failed: ${errorMessage(e)}`);
    } finally {
      passRunning = false;
    }
  };

  // Transcript retention (issue #197): at most once an hour, beside the lease sweep.
  const pruneTranscripts = transcriptPruner({
    db,
    dataDir: boot.dataDir,
    zones: () => live.current().dropZones,
    log,
  });
  const poll = pollTimer(live, () => void guardedPass());
  const leaseTimer = setInterval(() => {
    try {
      expireLeases(new Date());
    } catch (e) {
      log(`lease expiry failed: ${errorMessage(e)}`);
    }
    // After expiry: an expired, lost or cancelled drop's clone token is revoked.
    try {
      heldReadTokens.sweep(db);
    } catch (e) {
      log(`read token sweep failed: ${errorMessage(e)}`);
    }
    sweepStops();
    void pruneTranscripts(new Date());
  }, 10_000);

  await app.listen({ host: boot.listen.host, port: boot.listen.port });
  const address = app.server.address();
  if (address && typeof address === 'object') bound = { ...bound, port: address.port };
  log(listeningLine(boot.listen.host, bound.port, live.mode()));
  // No operator yet: one setup code per start (§7.5), printed once the URL it names answers.
  if (setupActive(db)) setup.rotateSetupCode();
  void guardedPass();

  return {
    app,
    store: live,
    async stop() {
      unsetLogSource();
      poll.stop();
      images.stop();
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
      serverLog(`fatal: ${errorMessage(e)}`);
      process.exit(1);
    },
  );
}
