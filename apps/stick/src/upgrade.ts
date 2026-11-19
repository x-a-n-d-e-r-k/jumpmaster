// The stick's side of upgrading itself in place (issue #430). The server only names a version
// and a digest on a lease answer (`x-jumpmaster-upgrade`); every decision to run new code is the
// stick's:
// 1. while an offer is held, the stick leases no new drop; it acts once its running drops and
//    pending pushes are done (the drain);
// 2. it refuses unless the offered version is strictly newer than its own, the reference names a
//    `jumpmaster-stick` image, the image fetched from the server's mirror is signed by this
//    repository's release workflow for exactly that version (`fetchFromServer` with `exactTag`:
//    no pin, cache or present image stands in), and the loaded image is titled
//    `jumpmaster-stick`;
// 3. on acceptance it writes `<state>/upgrade/pending.json` and starts the upgrade helper
//    (upgrade-helper.ts, issue #429) from the verified image id, with only the Docker socket and
//    the state mount, no network; the helper swaps the containers, and puts this one back unless
//    the new stick writes `<state>/upgrade/ok`;
// 4. the new stick writes `ok` once its self-check passed and a later lease was answered 2xx;
// 5. whichever stick runs next reports `<state>/upgrade/result.json` on every lease until one is
//    answered 2xx, then deletes it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compareReleaseVersions,
  parseReleaseVersion,
  type UpgradeOffer,
  type UpgradeReport,
  UpgradeReportSchema,
} from '@jumpmaster/protocol';
import type { LeaseUpgradeHooks } from './client.js';
import type { HelperMount, UpgradeDriver, UpgradeHelperSpec } from './driver.js';
import { fetchFromServer, type ServerImageDeps } from './fetch-image.js';
import type { UpgradeControl } from './lease-loop.js';
import { canonicalRef, type ImageTrust } from './verify.js';

/** The longest reason a report carries (the server's schema allows no more). */
export const UPGRADE_REASON_MAX = 500;
/** The stick image's repository name and its image title. */
export const STICK_IMAGE = 'jumpmaster-stick';
export const TITLE_LABEL = 'org.opencontainers.image.title';
/** The helper's entry point in the stick image, and how long it waits for the new stick. */
export const HELPER_ENTRY = '/app/apps/stick/dist/upgrade-helper.js';
export const HELPER_TIMEOUT_SECONDS = 900;
/** Where the Docker socket is mounted in the stick (the installer's `-v`). */
export const DOCKER_SOCKET = '/var/run/docker.sock';
/** The helper's exit code when another helper holds the lock. */
const HELPER_LOCKED = 3;

export type Decision = { ok: true; imageId: string } | { ok: false; reason: string };

export type DecideDeps = {
  /** How the image is fetched from the server's mirror. */
  server: ServerImageDeps;
  /** The engine, for the loaded image's id and labels. */
  images: Pick<UpgradeDriver, 'imageId' | 'imageLabels'>;
};

const cut = (s: string): string => s.slice(0, UPGRADE_REASON_MAX);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The repository name (last path segment, no tag) of a digest reference. */
export function repositoryName(ref: string): string {
  const at = ref.lastIndexOf('@');
  const name = at < 0 ? ref : ref.slice(0, at);
  return (name.split('/').at(-1) ?? '').replace(/:.*$/, '');
}

/**
 * Whether this stick runs `offer`: the checks of the top of this file, in order, the first
 * failing one refusing with its reason (at most 500 characters). Nothing is fetched unless the
 * version is newer and the reference names a stick image. Never throws.
 */
export async function decideUpgrade(
  offer: UpgradeOffer,
  own: { version: string },
  trust: ImageTrust,
  deps: DecideDeps,
): Promise<Decision> {
  const refuse = (reason: string): Decision => ({ ok: false, reason: cut(reason) });
  try {
    const mine = parseReleaseVersion(own.version);
    if (!mine) return refuse(`this stick has no release version (${own.version})`);
    const theirs = parseReleaseVersion(offer.version);
    if (!theirs || compareReleaseVersions(theirs, mine) <= 0)
      return refuse(`not newer than v${own.version}`);
    if (repositoryName(offer.image) !== STICK_IMAGE) return refuse('not a stick image reference');
    const fetched = await fetchFromServer(offer.image, trust, deps.server, {
      exactTag: `v${offer.version}`,
    });
    if (!fetched.ok)
      return refuse(
        fetched.reason.startsWith('image not verified')
          ? `signature check failed: ${fetched.reason}`
          : fetched.reason,
      );
    const id = await deps.images.imageId(canonicalRef(offer.image));
    if (!id) return refuse(`image ${offer.image} is not on the engine after its fetch`);
    const title = (await deps.images.imageLabels(id))[TITLE_LABEL];
    if (title !== STICK_IMAGE) return refuse(`not a stick image (titled ${title ?? 'nothing'})`);
    return { ok: true, imageId: id };
  } catch (e) {
    return refuse(`upgrade check failed: ${message(e)}`);
  }
}

/** The hand-off files the stick and the helper share, under `<state>/upgrade`. */
export function upgradeFiles(stateDir: string) {
  const dir = join(stateDir, 'upgrade');
  return {
    dir,
    pending: join(dir, 'pending.json'),
    ok: join(dir, 'ok'),
    result: join(dir, 'result.json'),
    lock: join(dir, 'lock'),
  };
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The version a `pending.json` names (`{"version": …}`, or the bare version). */
export function pendingVersion(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v === 'string') return v;
    const version = (v as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return t || undefined;
  }
}

/** A `result.json`'s report, its reason cut to 500 characters; null when it doesn't parse. */
export function parseResult(text: string): UpgradeReport | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = (v ?? {}) as { version?: unknown; result?: unknown; reason?: unknown };
  const parsed = UpgradeReportSchema.safeParse({
    version: o.version,
    result: o.result,
    ...(typeof o.reason === 'string' ? { reason: cut(o.reason) } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * At startup (issue #430): a `lock` with no helper container left is deleted, and so is a
 * `pending.json` naming another version than this stick's.
 */
export async function cleanupAtStartup(o: {
  stateDir: string;
  version: string;
  driver: Pick<UpgradeDriver, 'ownContainer' | 'containerExists'>;
  log: (line: string) => void;
}): Promise<void> {
  const files = upgradeFiles(o.stateDir);
  const pending = readOptional(files.pending);
  if (pending !== undefined && pendingVersion(pending) !== o.version) {
    rmSync(files.pending, { force: true });
    o.log(JSON.stringify({ event: 'upgrade-cleanup', removed: 'pending.json' }));
  }
  if (readOptional(files.lock) === undefined) return;
  try {
    const own = await o.driver.ownContainer();
    if (!own) return;
    if (await o.driver.containerExists(`${own.name}-upgrade`)) return;
    rmSync(files.lock, { force: true });
    o.log(JSON.stringify({ event: 'upgrade-cleanup', removed: 'lock' }));
  } catch (e) {
    o.log(JSON.stringify({ event: 'upgrade-cleanup', error: cut(message(e)) }));
  }
}

/** The helper's container spec: exactly the socket and state mounts, no network, auto-removed. */
export function helperSpec(o: {
  container: string;
  imageId: string;
  version: string;
  stateDir: string;
  socket: HelperMount;
  state: HelperMount;
}): UpgradeHelperSpec {
  return {
    name: `${o.container}-upgrade`,
    image: o.imageId,
    entrypoint: [
      'node',
      HELPER_ENTRY,
      '--container',
      o.container,
      '--image',
      o.imageId,
      '--version',
      o.version,
      '--state',
      o.stateDir,
      '--timeout',
      String(HELPER_TIMEOUT_SECONDS),
    ],
    mounts: [o.socket, o.state],
    networkMode: 'none',
    autoRemove: true,
  };
}

export type StickUpgradeDeps = {
  stateDir: string;
  /** This stick's own version. */
  version: string;
  trust: ImageTrust;
  /** How the offered image is fetched (the trust's server deps). */
  server: ServerImageDeps;
  driver: UpgradeDriver;
  /** Whether the stick can upgrade now (`canUpgrade`); offers are ignored otherwise. */
  enabled: () => boolean;
  /** Pending pushes: the stick acts only once there are none. */
  pendingPushes: () => number;
  log: (line: string) => void;
};

const sameOffer = (a: UpgradeOffer | undefined, b: UpgradeOffer | undefined): boolean =>
  a !== undefined && b !== undefined && a.version === b.version && a.image === b.image;

type Phase = 'idle' | 'draining' | 'deciding' | 'helper';

/**
 * The stick upgrade's state (issue #430): the lease loop's hold (`UpgradeControl`), the lease's
 * report (`LeaseUpgradeHooks`) and the new stick's health handshake.
 */
export class StickUpgrade implements UpgradeControl, LeaseUpgradeHooks {
  #offer: UpgradeOffer | undefined;
  #phase: Phase = 'idle';
  /** A report not in `result.json` (a refusal, a helper that failed to run). */
  #report: UpgradeReport | undefined;
  /** The startup self-check settled with its base check passing. */
  #checked = false;
  #confirmed = false;
  /** The current decision (up to the helper's start), and the helper's run (tests). */
  #acting: Promise<void> | undefined;
  #helper: Promise<void> | undefined;
  readonly #files: ReturnType<typeof upgradeFiles>;

  constructor(private readonly d: StickUpgradeDeps) {
    this.#files = upgradeFiles(d.stateDir);
  }

  #log(event: string, fields: Record<string, unknown> = {}): void {
    this.d.log(JSON.stringify({ event, ...fields }));
  }

  /** Settles when the current decision has, and the helper (if accepted) started (tests). */
  settled(): Promise<void> {
    return this.#acting ?? Promise.resolve();
  }

  /** Settles once the helper exited while this stick still runs (tests). */
  async helperExited(): Promise<void> {
    await this.#acting;
    await this.#helper;
  }

  holding(): boolean {
    return this.#phase !== 'idle';
  }

  answered(offer: UpgradeOffer | undefined): void {
    // Once the helper runs, it decides what happens to this stick.
    if (this.#phase === 'helper') return;
    if (!offer) {
      if (this.#offer) this.#log('upgrade-drain', { version: this.#offer.version, ended: true });
      this.#offer = undefined;
      if (this.#phase === 'draining') this.#phase = 'idle';
      return;
    }
    if (!this.d.enabled()) return;
    if (!sameOffer(offer, this.#offer))
      this.#log('upgrade-offer', { version: offer.version, image: offer.image });
    this.#offer = offer;
    if (this.#phase === 'idle') {
      this.#phase = 'draining';
      this.#log('upgrade-drain', { version: offer.version });
    }
  }

  idle(running: number): void {
    const offer = this.#offer;
    if (this.#phase !== 'draining' || !offer) return;
    if (running > 0 || this.d.pendingPushes() > 0) return;
    // One decision at a time: a later offer waits for this one (D3).
    this.#phase = 'deciding';
    this.#acting = this.#act(offer);
  }

  async #act(offer: UpgradeOffer): Promise<void> {
    const d = await decideUpgrade(offer, { version: this.d.version }, this.d.trust, {
      server: this.d.server,
      images: this.d.driver,
    });
    if (!d.ok) {
      this.#report = { version: offer.version, result: 'refused', reason: d.reason };
      this.#log('upgrade-refused', { version: offer.version, reason: d.reason });
      this.#resume();
      return;
    }
    if (!sameOffer(offer, this.#offer)) {
      // Withdrawn (or replaced) meanwhile: nothing starts.
      this.#phase = this.#offer ? 'draining' : 'idle';
      return;
    }
    this.#phase = 'helper';
    let run: { wait(): Promise<{ exitCode: number }> };
    try {
      run = await this.#startHelper(offer, d.imageId);
    } catch (e) {
      rmSync(this.#files.pending, { force: true });
      this.#fail(offer, `the upgrade helper did not start: ${message(e)}`);
      this.#resume();
      return;
    }
    this.#helper = this.#watch(offer, run);
  }

  async #watch(offer: UpgradeOffer, run: { wait(): Promise<{ exitCode: number }> }) {
    // Still running when it exits: the helper did not swap this stick out.
    let code: number;
    try {
      code = (await run.wait()).exitCode;
      this.#log('upgrade-helper-exited', { version: offer.version, exitCode: code });
    } catch (e) {
      code = -1;
      this.#log('upgrade-helper-exited', { version: offer.version, error: cut(message(e)) });
    }
    if (code === HELPER_LOCKED) {
      this.#fail(offer, 'another upgrade is running');
    } else {
      if (readOptional(this.#files.result) === undefined)
        this.#fail(offer, `the upgrade helper exited with code ${code}`);
      rmSync(this.#files.pending, { force: true });
    }
    this.#resume();
  }

  #fail(offer: UpgradeOffer, reason: string): void {
    this.#report = { version: offer.version, result: 'failed', reason: cut(reason) };
  }

  /** Leasing goes on: the offer is let go (the server's next answer says if it stands). */
  #resume(): void {
    this.#offer = undefined;
    this.#phase = 'idle';
  }

  async #startHelper(
    offer: UpgradeOffer,
    imageId: string,
  ): Promise<{ wait(): Promise<{ exitCode: number }> }> {
    const own = await this.d.driver.ownContainer();
    if (!own) throw new Error('this stick runs in no container it can name');
    const stateDir = resolve(this.d.stateDir);
    const state = own.mounts.find((m) => resolve(m.target) === stateDir);
    if (!state) throw new Error(`the state directory ${stateDir} is not a mount of this stick`);
    const socket = own.mounts.find((m) => m.target === DOCKER_SOCKET);
    if (!socket) throw new Error(`this stick has no ${DOCKER_SOCKET} mount`);
    mkdirSync(this.#files.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#files.pending, `${JSON.stringify({ version: offer.version })}\n`);
    const spec = helperSpec({
      container: own.name,
      imageId,
      version: offer.version,
      stateDir: this.d.stateDir,
      socket: { type: socket.type, source: socket.source, target: socket.target },
      state: { type: state.type, source: state.source, target: state.target },
    });
    const run = await this.d.driver.startUpgradeHelper(spec);
    this.#log('upgrade-helper-started', {
      version: offer.version,
      container: spec.name,
      image: imageId,
    });
    return run;
  }

  /** The startup self-check settled; the handshake waits for a passing base check. */
  selfCheckSettled(baseOk: boolean): void {
    if (baseOk) this.#checked = true;
  }

  beforeLease(): { report?: UpgradeReport; answered?: () => void } {
    const raw = readOptional(this.#files.result);
    let fromFile: UpgradeReport | undefined;
    if (raw !== undefined) {
      const parsed = parseResult(raw);
      if (parsed) fromFile = parsed;
      else {
        // Never resent forever: a file that doesn't parse is dropped.
        rmSync(this.#files.result, { force: true });
        this.#log('upgrade-reported', { dropped: 'result.json does not parse' });
      }
    }
    const report = fromFile ?? this.#report;
    const memory = fromFile ? undefined : this.#report;
    // Only a lease sent after the self-check passed confirms this stick's health.
    const confirms = this.#checked && !this.#confirmed;
    return {
      ...(report ? { report } : {}),
      answered: () => {
        if (fromFile) {
          // Deleted unless the helper wrote a new one meanwhile.
          if (readOptional(this.#files.result) === raw) rmSync(this.#files.result, { force: true });
          this.#log('upgrade-reported', { ...fromFile });
        } else if (memory && this.#report === memory) {
          this.#report = undefined;
          this.#log('upgrade-reported', { ...memory });
        }
        if (confirms) this.#confirm();
      },
    };
  }

  /** Writes `ok` when `pending.json` names this stick's own version. */
  #confirm(): void {
    if (this.#confirmed) return;
    if (pendingVersion(readOptional(this.#files.pending)) !== this.d.version) return;
    try {
      writeFileSync(this.#files.ok, this.d.version);
      this.#confirmed = true;
      this.#log('upgrade-confirmed', { version: this.d.version });
    } catch (e) {
      this.#log('upgrade-confirmed', { error: cut(message(e)) });
    }
  }
}
