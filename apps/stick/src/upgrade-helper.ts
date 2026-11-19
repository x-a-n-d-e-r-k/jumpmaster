// The upgrade helper (issue #429): a second entry point in the stick image that replaces the
// running stick container with one from a new stick image, and puts the old one back unless the
// new stick confirms it is healthy. The old stick starts it (issue #430); a running container
// can't replace itself.
//
//   node /app/apps/stick/dist/upgrade-helper.js --container <name> --image <image id>
//     --version <version> --state <dir> [--timeout <seconds>]
//
// Exit codes: 0 upgraded; 1 failed (rolled back, or the rollback failed); 2 refused before any
// container changed; 3 another helper holds the lock.
//
// Known limit: if the host reboots or Docker restarts between stopping the old container and
// starting the new one, neither may run (Docker doesn't restart a container stopped by hand).
// Command recovers with `docker start` of `<name>-previous` or `<name>`.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The tag the installer runs the stick from; moved to the new image on success. */
export const INSTALLED_TAG = 'jumpmaster-stick:installed';
export const DEFAULT_TIMEOUT_SECONDS = 900;
/** How much older than the timeout a lock must be before another helper may replace it. */
const LOCK_GRACE_SECONDS = 180;
const POLL_MS = 5_000;
const STOP_TIMEOUT_SECONDS = 10;
/** Each restore call: the first try and up to 3 retries, 5 s apart. */
const RESTORE_RETRIES = 3;
const RESTORE_RETRY_MS = 5_000;
const REASON_MAX = 500;

export interface OldContainer {
  id: string;
  imageId: string;
  /** `Config.Env`. */
  env: string[];
  /** `Config.Labels`. */
  labels: Record<string, string>;
  hostConfig: Record<string, unknown>;
  running: boolean;
  restartCount: number;
}

export interface ImageInfo {
  id: string;
  /** `Config.Env`. */
  env: string[];
  /** `Config.Labels`. */
  labels: Record<string, string>;
}

/** What the new container is created with; Cmd, Entrypoint, User and WorkingDir are the image's. */
export interface ContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown>;
}

/** Thrown by a container call (start, stop, rename, remove) when no container has the name. */
export class NoSuchContainer extends Error {
  constructor(name: string) {
    super(`no such container: ${name}`);
    this.name = 'NoSuchContainer';
  }
}

/**
 * The Docker calls the helper makes. Inspections return undefined for a missing object;
 * the other container calls throw {@link NoSuchContainer} for one.
 */
export interface UpgradeDocker {
  inspectContainer(name: string): Promise<OldContainer | undefined>;
  inspectImage(id: string): Promise<ImageInfo | undefined>;
  create(name: string, spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutSeconds: number): Promise<void>;
  rename(name: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Never forced. */
  removeImage(id: string): Promise<void>;
  tag(imageId: string, repoTag: string): Promise<void>;
}

export interface UpgradeDeps {
  docker: UpgradeDocker;
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface UpgradeOptions {
  container: string;
  image: string;
  version: string;
  /** The stick's state directory; the helper's files live under `<stateDir>/upgrade/`. */
  stateDir: string;
  timeoutSeconds: number;
}

export interface UpgradeResult {
  exitCode: 0 | 1 | 2 | 3;
  result?: 'ok' | 'failed';
  reason?: string;
}

/** A refusal before any container changed (exit 2). */
class Precondition extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The new container's spec: the old container's host config, and its env and labels minus what
 * the old image set (so the installer's settings stay and the new image's defaults apply).
 */
export function nextSpec(old: OldContainer, oldImage: ImageInfo, image: string): ContainerSpec {
  const imageEnv = new Set(oldImage.env);
  const Labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(old.labels)) if (oldImage.labels[k] !== v) Labels[k] = v;
  return {
    Image: image,
    Env: old.env.filter((e) => !imageEnv.has(e)),
    Labels,
    HostConfig: structuredClone(old.hostConfig),
  };
}

/** The version in an `ok` or `pending.json` file: `{"version": …}` or the bare version. */
function versionIn(text: string): string | undefined {
  const t = text.trim();
  try {
    const parsed: unknown = JSON.parse(t);
    if (typeof parsed === 'string') return parsed;
    const v = (parsed as { version?: unknown } | null)?.version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    // not JSON: the bare version
  }
  return t || undefined;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Takes the lock with an exclusive create. A lock younger than the timeout plus 180 s belongs to
 * a running helper: false, nothing touched. An older one is replaced.
 */
function takeLock(path: string, now: number, timeoutSeconds: number): boolean {
  const maxAgeMs = (timeoutSeconds + LOCK_GRACE_SECONDS) * 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      try {
        writeFileSync(fd, `${new Date(now).toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let started = Date.parse(readOptional(path)?.trim() ?? '');
    if (Number.isNaN(started)) {
      try {
        started = statSync(path).mtimeMs;
      } catch {
        continue; // gone meanwhile: try again
      }
    }
    if (now - started < maxAgeMs) return false;
    rmSync(path, { force: true });
  }
  return false;
}

export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<UpgradeResult> {
  const { docker } = deps;
  const name = opts.container;
  const previous = `${name}-previous`;
  const next = `${name}-next`;
  const dir = join(opts.stateDir, 'upgrade');
  const files = {
    lock: join(dir, 'lock'),
    pending: join(dir, 'pending.json'),
    ok: join(dir, 'ok'),
    result: join(dir, 'result.json'),
    log: join(dir, 'helper.log'),
  };
  let logToFile = false;
  // Fields are names, ids, versions and docker errors: never an environment value.
  const step = (stepName: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ event: 'upgrade-step', step: stepName, ...fields });
    deps.log(line);
    if (!logToFile) return;
    try {
      appendFileSync(files.log, `${line}\n`);
    } catch {
      // the logger still has it
    }
  };

  // The lock comes first, so a second helper writes and deletes nothing, not even the running
  // helper's log. Synchronous, so of two helpers started together exactly one gets it.
  mkdirSync(dir, { recursive: true });
  if (!takeLock(files.lock, deps.now(), opts.timeoutSeconds)) {
    step('locked', { reason: 'another upgrade helper is running' });
    return { exitCode: 3 };
  }
  try {
    writeFileSync(files.log, '');
    logToFile = true;
  } catch {
    // logging to the file is best effort
  }

  const writeResult = (result: 'ok' | 'failed', reason?: string) => {
    const body: { version: string; result: string; reason?: string } = {
      version: opts.version,
      result,
    };
    if (reason !== undefined) body.reason = reason.slice(0, REASON_MAX);
    writeAtomic(files.result, `${JSON.stringify(body)}\n`);
  };
  const clearHandoff = () => {
    rmSync(files.ok, { force: true });
    rmSync(files.pending, { force: true });
  };
  const fail = (code: 1 | 2, reason: string): UpgradeResult => {
    const cut = reason.slice(0, REASON_MAX);
    try {
      writeResult('failed', cut);
    } catch (e) {
      step('result-write-failed', { error: message(e) });
    }
    step('failed', { exitCode: code, reason: cut });
    return { exitCode: code, result: 'failed', reason: cut };
  };

  try {
    step('start', {
      container: name,
      image: opts.image,
      version: opts.version,
      timeoutSeconds: opts.timeoutSeconds,
    });

    // Steps 3–5: preconditions. Nothing changes before they all hold.
    let old: OldContainer;
    let oldImage: ImageInfo;
    try {
      const pending = readOptional(files.pending);
      if (pending === undefined) throw new Precondition('no pending.json');
      const wanted = versionIn(pending);
      if (wanted !== opts.version)
        throw new Precondition(`pending.json names ${wanted ?? 'no version'}, not ${opts.version}`);
      step('pending-ok');

      const found = await docker.inspectContainer(name);
      if (!found) throw new Precondition(`container ${name} not found`);
      if (!found.running) throw new Precondition(`container ${name} is not running`);
      old = found;
      const newImage = await docker.inspectImage(opts.image);
      if (!newImage) throw new Precondition(`image ${opts.image} not found`);
      const oldImg = await docker.inspectImage(old.imageId);
      if (!oldImg) throw new Precondition(`the old container's image ${old.imageId} not found`);
      oldImage = oldImg;
      step('inspected', { oldImage: old.imageId, newImage: opts.image });

      for (const leftover of [previous, next]) {
        const c = await docker.inspectContainer(leftover);
        if (c?.running) throw new Precondition(`${leftover} is running`);
      }
      rmSync(files.ok, { force: true });
      for (const leftover of [previous, next]) {
        if (await docker.inspectContainer(leftover)) {
          await docker.remove(leftover);
          step('removed-leftover', { container: leftover });
        }
      }
    } catch (e) {
      return fail(2, message(e));
    }

    // Step 6: the next container, created but not started. The old stick is untouched.
    try {
      await docker.create(next, nextSpec(old, oldImage, opts.image));
      step('created', { container: next });
    } catch (e) {
      const reason = `creating ${next} failed: ${message(e)}`;
      try {
        if (await docker.inspectContainer(next)) await docker.remove(next);
      } catch (e2) {
        step('cleanup-failed', { container: next, error: message(e2) });
      }
      return fail(1, reason);
    }

    // Steps 7–8: swap, then wait for the new stick's `ok`.
    const swap = { oldRenamed: false, nextRenamed: false };
    let reason: string | undefined;
    try {
      await docker.stop(name, STOP_TIMEOUT_SECONDS);
      step('stopped-old', { container: name });
      await docker.rename(name, previous);
      swap.oldRenamed = true;
      await docker.rename(next, name);
      swap.nextRenamed = true;
      step('swapped', { container: name, previous });
      await docker.start(name);
      step('started-new', { container: name });
      reason = await waitHealthy();
    } catch (e) {
      reason = message(e);
    }

    if (reason === undefined) {
      step('healthy', { version: opts.version });
      // The tag first: an old image the tag still names could not be removed unforced.
      try {
        await docker.tag(opts.image, INSTALLED_TAG);
        step('tagged', { image: opts.image, tag: INSTALLED_TAG });
      } catch (e) {
        step('tag-failed', { error: message(e) });
      }
      try {
        await docker.remove(previous);
        step('removed-previous', { container: previous });
      } catch (e) {
        step('remove-previous-failed', { error: message(e) });
      }
      if (old.imageId !== opts.image) {
        try {
          await docker.removeImage(old.imageId);
          step('removed-old-image', { image: old.imageId });
        } catch (e) {
          step('remove-old-image-failed', { image: old.imageId, error: message(e) });
        }
      }
      clearHandoff();
      writeResult('ok');
      step('done', { result: 'ok' });
      return { exitCode: 0, result: 'ok' };
    }

    return await rollback(reason, swap);
  } catch (e) {
    return fail(1, message(e));
  } finally {
    rmSync(files.lock, { force: true });
  }

  /** Undefined once `ok` holds the version; else why the new stick failed. */
  async function waitHealthy(): Promise<string | undefined> {
    const deadline = deps.now() + opts.timeoutSeconds * 1000;
    for (;;) {
      const ok = readOptional(files.ok);
      if (ok !== undefined && versionIn(ok) === opts.version) return undefined;
      const c = await docker.inspectContainer(name);
      if (!c) return 'the new stick disappeared';
      if (c.restartCount > 0) return 'the new stick restarted';
      if (!c.running) return 'the new stick stopped';
      if (deps.now() >= deadline)
        return `the new stick did not confirm within ${opts.timeoutSeconds} s`;
      await deps.sleep(Math.min(POLL_MS, Math.max(0, deadline - deps.now())));
    }
  }

  /** One restore call, tried again up to 3 times, 5 s apart. */
  async function retried(what: string, call: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await call();
        return;
      } catch (e) {
        step('restore-retry', { call: what, attempt: attempt + 1, error: message(e) });
        if (attempt >= RESTORE_RETRIES) throw e;
        await deps.sleep(RESTORE_RETRY_MS);
      }
    }
  }

  /** Step 10: the new container out, result.json written, then the old stick back. */
  async function rollback(
    why: string,
    swap: { oldRenamed: boolean; nextRenamed: boolean },
  ): Promise<UpgradeResult> {
    step('rollback', { reason: why });
    step('recovery-note', {
      note: `if the host or Docker restarts during an upgrade, neither stick may be running: start the old one with docker start ${previous} (or docker start ${name})`,
    });
    let rollbackError: unknown;
    try {
      const newName = swap.nextRenamed ? name : next;
      // A new container that no longer exists counts as removed.
      let gone = false;
      const unlessGone = (call: () => Promise<void>) => async () => {
        if (gone) return;
        try {
          await call();
        } catch (e) {
          if (!(e instanceof NoSuchContainer)) throw e;
          gone = true;
        }
      };
      await retried(
        `stop ${newName}`,
        unlessGone(() => docker.stop(newName, STOP_TIMEOUT_SECONDS)),
      );
      await retried(
        `remove ${newName}`,
        unlessGone(() => docker.remove(newName)),
      );
      step(gone ? 'new-already-gone' : 'removed-new', { container: newName });
    } catch (e) {
      rollbackError = e;
    }
    clearHandoff();
    // Before the old stick starts: it reports this result to the server (issue #430).
    writeResult('failed', why);
    if (rollbackError === undefined) {
      try {
        if (swap.oldRenamed) {
          await retried(`rename ${previous} ${name}`, () => docker.rename(previous, name));
          swap.oldRenamed = false;
        }
        // Even when its stop threw: starting a running container changes nothing.
        await retried(`start ${name}`, () => docker.start(name));
        step('restored', { container: name });
      } catch (e) {
        rollbackError = e;
      }
    }
    if (rollbackError === undefined) return fail(1, why);
    const manual = [
      ...(swap.nextRenamed && swap.oldRenamed ? [`docker rm -f ${name}`] : []),
      ...(swap.oldRenamed ? [`docker rename ${previous} ${name}`] : []),
      `docker start ${name}`,
    ];
    step('rollback-failed', { error: message(rollbackError), restoreWith: manual.join(' && ') });
    return fail(1, `rollback failed: ${message(rollbackError)} (after: ${why})`);
  }
}

/** The command line; usage errors throw. */
export function parseCommandLine(argv: string[]): UpgradeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      container: { type: 'string' },
      image: { type: 'string' },
      version: { type: 'string' },
      state: { type: 'string' },
      timeout: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const { container, image, version, state } = values;
  if (!container || !image || !version || !state) throw new Error('missing option');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('bad --container');
  const timeoutSeconds =
    values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('bad --timeout');
  return { container, image, version, stateDir: state, timeoutSeconds };
}

const USAGE =
  'usage: upgrade-helper.js --container <name> --image <image id> --version <version> --state <dir> [--timeout <seconds>]';

async function main(): Promise<number> {
  let opts: UpgradeOptions;
  try {
    opts = parseCommandLine(process.argv.slice(2));
  } catch (e) {
    console.error(`${message(e)}\n${USAGE}`);
    return 2;
  }
  const { dockerUpgrade } = await import('./upgrade-docker.js');
  const result = await runUpgrade(opts, {
    docker: dockerUpgrade('/var/run/docker.sock'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  });
  return result.exitCode;
}

/** Whether this module is the program node was started with (not an import, as in the tests). */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const self = fileURLToPath(import.meta.url);
  for (const candidate of [arg, `${arg}.js`]) {
    try {
      if (realpathSync(candidate) === realpathSync(self)) return true;
    } catch {
      // not this one
    }
  }
  return false;
}

if (isEntry()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(message(e));
      process.exitCode = 1;
    },
  );
}
