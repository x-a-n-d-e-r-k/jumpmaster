import {
  type ArtifactUpload,
  type CloneGrant,
  CloneGrantSchema,
  type ClonePlan,
  ClonePlanSchema,
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  FEATURES_HEADER,
  type ImageFetch,
  type LeaseSkip,
  LeaseSkipSchema,
  type PushGrant,
  PushGrantSchema,
  type PushPlan,
  PushPlanSchema,
  type PushResult,
  SKIPPED_HEADER,
  SLOTS_HEADER,
  type StickInfo,
  type StickStarting,
  type TrooperEvent,
  UPGRADE_HEADER,
  type UpgradeOffer,
  UpgradeOfferSchema,
  type UpgradeReport,
} from '@jumpmaster/protocol';

export type Ack = 'ok' | 'stale';

/**
 * What a lease says beyond the advert: the latest checks' capabilities, `noPush` at the cap, and
 * the stick's health for the sticks page (issue #138).
 */
export type LeaseTerms = {
  capabilities?: string[];
  noPush?: boolean;
  health?: { docker: string; freeBytes: number | null };
};

/** `killed` only for a pending push while the kill switch is on: stop, keep the volume. */
export type Beat = 'ok' | 'cancel' | 'hard_cancel' | 'stale' | 'killed';

/** The server's answer to a grant request; a refusal is told apart from stale by its body. */
/** A push plan, `stale`, or why pushes are held back for now. */
export type PlanReply = PushPlan | 'stale' | { refused: string; retryable: boolean };

export type GrantReply =
  | { grant: PushGrant }
  | { refused: string; retryable: boolean }
  | { stale: true };

/** A clone plan, `stale`, or why a clone is held back (403 `{refused, retryable}`). */
export type ClonePlanReply = ClonePlan | 'stale' | { refused: string; retryable: boolean };

/** A clone grant, why not, or stale; told apart by the body, as for a push grant. */
export type CloneGrantReply =
  | { grant: CloneGrant }
  | { stale: true }
  | { refused: string; retryable: boolean };

/** The per-drop calls the runner needs. */
export interface DropClient {
  /** What the server announced on its last lease answer (`push-v1`); none when unknown. */
  readonly features?: ReadonlySet<string>;
  heartbeat(dropId: string, epoch: number): Promise<Beat>;
  postEvents(dropId: string, epoch: number, events: TrooperEvent[]): Promise<Ack>;
  postResult(dropId: string, epoch: number, result: DropResult): Promise<Ack>;
  postArtifact(dropId: string, epoch: number, artifact: ArtifactUpload): Promise<Ack>;
  /** Asks the server to keep this drop's volume for a push: `refused` means remove it. */
  salvage(dropId: string, epoch: number): Promise<'ok' | 'refused'>;
}

/** The calls the push loop needs. */
export interface PushClient {
  heartbeat(dropId: string, epoch: number): Promise<Beat>;
  pushPlan(dropId: string, epoch: number): Promise<PlanReply>;
  pushGrant(dropId: string, epoch: number): Promise<GrantReply>;
  postPushResult(dropId: string, epoch: number, result: PushResult): Promise<Ack>;
}

/** The calls a GitLab drop's clone container needs (issue #851). */
export interface CloneClient {
  clonePlan(dropId: string, epoch: number): Promise<ClonePlanReply>;
  cloneGrant(dropId: string, epoch: number): Promise<CloneGrantReply>;
}

/**
 * The stick upgrade's part in each lease (issue #430): asked before every lease what it reports,
 * and told when that lease is answered 2xx (a 204 included).
 */
export interface LeaseUpgradeHooks {
  beforeLease(): { report?: UpgradeReport; answered?: () => void };
}

/** A request the server answered with an error status (never thrown for a network failure). */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Shorter than the 15-second beat, so beats never overlap. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How much of a refused request's body goes into the error (it is the server's error JSON). */
const ERROR_BODY_CHARS = 400;

async function failure(what: string, res: Response): Promise<Error> {
  const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  const body = text.length > ERROR_BODY_CHARS ? `${text.slice(0, ERROR_BODY_CHARS)}…` : text;
  return new Error(`${what} failed: ${res.status}${body ? ` ${body}` : ''}`);
}

/** The skipped zones a lease response names; a missing or malformed header is none. */
function skippedOf(res: Response): LeaseSkip[] {
  const raw = res.headers.get(SKIPPED_HEADER);
  if (!raw) return [];
  try {
    const parsed = LeaseSkipSchema.array().safeParse(JSON.parse(decodeURIComponent(raw)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The trooper count a lease answer carries; null when missing or not an integer of 1 or more. */
function slotsOf(res: Response): number | null {
  const raw = res.headers.get(SLOTS_HEADER)?.trim() ?? '';
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

/**
 * Lease logging that doesn't flood: each distinct skip reason and each distinct lease error is
 * logged at most once a minute, though the stick polls every few seconds.
 */
export function leaseLogger(
  log: (line: string) => void,
  now: () => number = Date.now,
  everyMs = 60_000,
) {
  const last = new Map<string, number>();
  const once = (line: string) => {
    const t = now();
    const at = last.get(line);
    if (at !== undefined && t - at < everyMs) return;
    last.set(line, t);
    log(line);
  };
  return {
    skipped(list: LeaseSkip[]) {
      for (const s of list)
        once(`lease: zone ${s.zoneId} skipped: this stick lacks ${s.missing.join(', ')}`);
    },
    error(message: string) {
      once(`lease error: ${message}`);
    },
  };
}

export class StickClient implements DropClient, PushClient, CloneClient {
  /** The features the server announced on its latest lease answer. */
  features: ReadonlySet<string> = new Set();
  /**
   * The upgrade the server offered on its latest lease answer (issue #430); undefined when that
   * answer had none, or one that fails its schema (which is logged).
   */
  upgradeOffer: UpgradeOffer | undefined;
  /** The stick upgrade's reporting, when it is wired (issue #430). */
  upgradeHooks: LeaseUpgradeHooks | undefined;

  constructor(
    private readonly baseUrl: string,
    private token?: string,
    private readonly opts: {
      heartbeatTimeoutMs?: number;
      info?: StickInfo;
      /** The stick's ceiling, sent with every lease. */
      maxSlots?: number;
      /** The stick's starting count (`JM_SLOTS`), sent with every lease. */
      slots?: number;
      /** Where a malformed upgrade offer is logged; default stderr. */
      log?: (line: string) => void;
    } = {},
  ) {}

  /** The terms of the latest lease, for a progress report between leases. */
  private lastTerms: LeaseTerms | undefined;
  /**
   * The image download to report (issue #141): sent on every lease while set; `null` is sent once
   * when a download ends; `undefined` sends nothing (as before server-hosted images).
   */
  private imageFetch: ImageFetch | null | undefined;
  /**
   * The first health check to report (issue #157): sent on every lease while set; `null` is sent
   * once when the check has a result; `undefined` sends nothing.
   */
  private startingReport: StickStarting | null | undefined;

  /** What this stick advertises on enroll and on every lease (an M3 stick sent nothing). */
  private get info(): Partial<StickInfo> {
    return this.advertised ?? this.opts.info ?? {};
  }

  private advertised: StickInfo | undefined;

  /** Replaces what the stick advertises, for a client made before its checks finished. */
  advertise(info: StickInfo): void {
    this.advertised = info;
  }

  private async req(
    path: string,
    body: unknown,
    auth = true,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-jumpmaster-protocol': '1',
    };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Enrolls with the join token, or with a one-time code (issue #138), whose invite names the
   * stick: the server's answer then carries that `name`.
   */
  async enroll(
    credential: string | { joinToken: string } | { enrollCode: string },
    name: string,
    slots: number,
  ): Promise<{ stickId: string; stickToken: string; name?: string }> {
    const cred = typeof credential === 'string' ? { joinToken: credential } : credential;
    const res = await this.req('/api/sticks/enroll', { ...cred, name, slots, ...this.info }, false);
    if (!res.ok) throw await failure('enroll', res);
    const out = (await res.json()) as { stickId: string; stickToken: string; name?: string };
    this.token = out.stickToken;
    return out;
  }

  /**
   * Long-polls. `drop` is null when the server has nothing (204). `skipped` names zones with work
   * waiting that this stick can't run, and what it lacks for each. `terms` override what the
   * stick advertised at startup: the capabilities of its latest checks, and `noPush` at the cap.
   * `slots` is the trooper count the server wants (null from an older server).
   */
  async lease(
    freeSlots: number,
    terms: LeaseTerms = {},
  ): Promise<{ drop: DropPayload | null; skipped: LeaseSkip[]; slots: number | null }> {
    const { maxSlots: max, slots: start } = this.opts;
    this.lastTerms = terms;
    const fetching = this.imageFetch;
    const starting = this.startingReport;
    const upgrade = this.upgradeHooks?.beforeLease() ?? {};
    const res = await this.req('/api/sticks/lease', {
      freeSlots,
      ...this.info,
      ...terms,
      ...(max === undefined ? {} : { maxSlots: max }),
      ...(start === undefined ? {} : { slots: start }),
      ...(fetching === undefined ? {} : { imageFetch: fetching }),
      ...(starting === undefined ? {} : { starting }),
      ...(upgrade.report === undefined ? {} : { upgrade: upgrade.report }),
    });
    // The end of a download, and of the first check, is said once.
    if (fetching === null && this.imageFetch === null) this.imageFetch = undefined;
    if (starting === null && this.startingReport === null) this.startingReport = undefined;
    this.features = featuresOf(res);
    this.upgradeOffer = this.offerOf(res);
    if (res.ok) upgrade.answered?.();
    const skipped = skippedOf(res);
    const slots = slotsOf(res);
    if (res.status === 204) return { drop: null, skipped, slots };
    // A refusal's body is the server's error JSON, never a payload: safe to show.
    if (!res.ok) throw await failure('lease', res);
    const parsed = DropPayloadSchema.safeParse(await res.json());
    // Never echo a 2xx body: it carries credentials.
    if (!parsed.success) throw new Error('lease failed: invalid lease payload');
    return { drop: parsed.data, skipped, slots };
  }

  /**
   * Reports an image download's progress (or, with `null`, its end) on a lease with no free slot,
   * under the latest lease's terms, so nothing is leased by it (issue #141). Before the first
   * lease it only waits for that lease. Never throws: a lost report is replaced by the next.
   */
  async reportImageFetch(p: ImageFetch | null): Promise<void> {
    this.imageFetch = p;
    if (!this.lastTerms) return;
    await this.lease(0, this.lastTerms).catch(() => {});
  }

  /**
   * Sets the starting report (issue #157) the next leases carry: the image the first health check
   * is checking, or `null` once it has a result. Sends nothing itself: the lease loop reports.
   */
  reportStarting(s: StickStarting | null): void {
    this.startingReport = s;
  }

  /**
   * The server's OCI layout tar of `ref` (a digest reference) for `platform` (issue #141). The
   * server knows an image by its last path segment and digest. The caller reads the status.
   */
  async imageLayout(ref: string, platform: string, signal: AbortSignal): Promise<Response> {
    const at = ref.lastIndexOf('@');
    // A tag beside the digest is dropped (the last segment holds no registry port).
    const name = (ref.slice(0, at).split('/').at(-1) ?? '').replace(/:.*$/, '');
    const path = `/api/sticks/images/${encodeURIComponent(`${name}${ref.slice(at)}`)}/oci.tar`;
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('platform', platform);
    const headers: Record<string, string> = { 'x-jumpmaster-protocol': '1' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(url, { method: 'GET', headers, signal });
  }

  async heartbeat(dropId: string, epoch: number): Promise<Beat> {
    // A hung server must count as a failed beat, or a stick cut off from it never fences itself.
    const res = await this.req(
      `/api/drops/${dropId}/heartbeat`,
      { epoch },
      true,
      AbortSignal.timeout(this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS),
    );
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
    const out = (await res.json()) as { cancel: boolean; hard?: boolean; killed?: boolean };
    if (out.killed === true) return 'killed';
    if (!out.cancel) return 'ok';
    return out.hard ? 'hard_cancel' : 'cancel';
  }

  async postArtifact(dropId: string, epoch: number, artifact: ArtifactUpload): Promise<Ack> {
    const res = await this.req(`/api/drops/${dropId}/artifacts`, { epoch, ...artifact });
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`artifact upload failed: ${res.status}`);
    return 'ok';
  }

  async postEvents(dropId: string, epoch: number, events: TrooperEvent[]): Promise<Ack> {
    const res = await this.req(`/api/drops/${dropId}/events`, { epoch, events });
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`events failed: ${res.status}`);
    return 'ok';
  }

  /** Retries 5xx (e.g. forge failure while finalizing) with backoff. */
  async postResult(dropId: string, epoch: number, result: DropResult): Promise<Ack> {
    let last = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const res = await this.req(`/api/drops/${dropId}/result`, { epoch, result });
      if (res.status === 409) return 'stale';
      if (res.ok) return 'ok';
      last = res.status;
      if (res.status < 500) break;
    }
    throw new HttpStatusError(`result failed: ${last}`, last);
  }

  /**
   * The plan for a push container; `stale` when the drop is no longer this stick's pending push; a
   * refusal (403 `{refused, retryable}`) while pushes are held back (the kill switch, observe).
   */
  async pushPlan(dropId: string, epoch: number): Promise<PlanReply> {
    const res = await this.req('/api/sticks/push-plan', { dropId, epoch });
    if (res.status === 409) return 'stale';
    if (res.status === 403) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { refused?: unknown; retryable?: unknown } | null;
      if (typeof body?.refused === 'string') {
        return { refused: body.refused, retryable: body.retryable === true };
      }
    }
    if (!res.ok) throw await failure('push-plan', res);
    const parsed = PushPlanSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('push-plan failed: invalid plan');
    return parsed.data;
  }

  /**
   * The grant, or why not. A refusal is 403 `{refused, retryable}`, except `reserved`, which is
   * 409 like stale: the body tells them apart. A grant's body is never echoed (it holds a token).
   */
  async pushGrant(dropId: string, epoch: number): Promise<GrantReply> {
    const res = await this.req('/api/sticks/push-token', { dropId, epoch });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { grant?: unknown } | null;
      const parsed = PushGrantSchema.safeParse(body?.grant);
      if (!parsed.success) throw new Error('push-token failed: invalid grant');
      return { grant: parsed.data };
    }
    if (res.status === 403 || res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        stale?: unknown;
        refused?: unknown;
        retryable?: unknown;
      } | null;
      if (typeof body?.refused === 'string') {
        return { refused: body.refused, retryable: body.retryable === true };
      }
      if (res.status === 409) return { stale: true };
    }
    throw new HttpStatusError(`push-token failed: ${res.status}`, res.status);
  }

  /**
   * The plan for a clone container; `stale` on 409; a refusal on 403 `{refused, retryable}`. Any
   * other failure throws its status only: no part of a response body goes into the error.
   */
  async clonePlan(dropId: string, epoch: number): Promise<ClonePlanReply> {
    const res = await this.req('/api/sticks/clone-plan', { dropId, epoch });
    if (res.status === 409) return 'stale';
    if (res.status === 403) {
      const refusal = refusalOf(await res.json().catch(() => null));
      if (refusal) return refusal;
    }
    if (!res.ok) throw new HttpStatusError(`clone-plan failed: ${res.status}`, res.status);
    const parsed = ClonePlanSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('clone-plan failed: invalid plan');
    return parsed.data;
  }

  /**
   * The clone grant, or why not. A refusal is 403 `{refused, retryable}`, except `reserved`, which
   * is 409 like stale: the body tells them apart. No body is ever echoed (a grant holds a token).
   */
  async cloneGrant(dropId: string, epoch: number): Promise<CloneGrantReply> {
    const res = await this.req('/api/sticks/clone-token', { dropId, epoch });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { grant?: unknown } | null;
      const parsed = CloneGrantSchema.safeParse(body?.grant);
      if (!parsed.success) throw new Error('clone-token failed: invalid grant');
      return { grant: parsed.data };
    }
    if (res.status === 403 || res.status === 409) {
      const refusal = refusalOf(await res.json().catch(() => null));
      if (refusal) return refusal;
      if (res.status === 409) return { stale: true };
    }
    throw new HttpStatusError(`clone-token failed: ${res.status}`, res.status);
  }

  /** 200 is ok, a retry after a lost response included (Ruling 13); 409 is stale; 5xx retried. */
  async postPushResult(dropId: string, epoch: number, result: PushResult): Promise<Ack> {
    let last = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const res = await this.req(`/api/drops/${dropId}/push-result`, { epoch, result });
      if (res.status === 409) return 'stale';
      if (res.ok) return 'ok';
      last = res.status;
      if (res.status < 500) break;
    }
    throw new HttpStatusError(`push-result failed: ${last}`, last);
  }

  /** The answer's upgrade offer; a malformed one is ignored and logged. */
  private offerOf(res: Response): UpgradeOffer | undefined {
    const { offer, malformed } = upgradeOfferOf(res);
    if (malformed !== undefined)
      (this.opts.log ?? ((l: string) => console.error(l)))(
        JSON.stringify({ event: 'upgrade-offer', ignored: malformed.slice(0, 300) }),
      );
    return offer;
  }

  async salvage(dropId: string, epoch: number): Promise<'ok' | 'refused'> {
    const res = await this.req('/api/sticks/salvage', { dropId, epoch });
    if (res.status === 409) return 'refused';
    if (!res.ok) throw await failure('salvage', res);
    return 'ok';
  }
}

/** A `{refused, retryable}` body as a refusal; `retryable` only when the body says `true`. */
function refusalOf(body: unknown): { refused: string; retryable: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { refused, retryable } = body as { refused?: unknown; retryable?: unknown };
  return typeof refused === 'string' ? { refused, retryable: retryable === true } : null;
}

/** The upgrade offer a lease answer carries; undefined when there is none or it is malformed. */
function upgradeOfferOf(res: Response): { offer?: UpgradeOffer; malformed?: string } {
  const raw = res.headers.get(UPGRADE_HEADER);
  if (raw === null) return {};
  try {
    const parsed = UpgradeOfferSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { offer: parsed.data };
    return { malformed: parsed.error.issues.map((i) => i.message).join('; ') };
  } catch {
    return { malformed: 'not JSON' };
  }
}

/** The features a lease answer announces (a comma list); none when the header is missing. */
function featuresOf(res: Response): ReadonlySet<string> {
  const raw = res.headers.get(FEATURES_HEADER) ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
}
