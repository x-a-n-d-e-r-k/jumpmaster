import {
  type ArtifactUpload,
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  type LeaseSkip,
  LeaseSkipSchema,
  SKIPPED_HEADER,
  type StickInfo,
  type TrooperEvent,
} from '@jumpmaster/protocol';

export type Ack = 'ok' | 'stale';

/** The per-drop calls the runner needs. */
export interface DropClient {
  heartbeat(dropId: string, epoch: number): Promise<'ok' | 'cancel' | 'hard_cancel' | 'stale'>;
  postEvents(dropId: string, epoch: number, events: TrooperEvent[]): Promise<Ack>;
  postResult(dropId: string, epoch: number, result: DropResult): Promise<Ack>;
  postArtifact(dropId: string, epoch: number, artifact: ArtifactUpload): Promise<Ack>;
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

export class StickClient implements DropClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
    private readonly opts: { heartbeatTimeoutMs?: number; info?: StickInfo } = {},
  ) {}

  /** What this stick advertises on enroll and on every lease (an M3 stick sent nothing). */
  private get info(): Partial<StickInfo> {
    return this.opts.info ?? {};
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

  async enroll(
    joinToken: string,
    name: string,
    slots: number,
  ): Promise<{ stickId: string; stickToken: string }> {
    const res = await this.req(
      '/api/sticks/enroll',
      { joinToken, name, slots, ...this.info },
      false,
    );
    if (!res.ok) throw await failure('enroll', res);
    const out = (await res.json()) as { stickId: string; stickToken: string };
    this.token = out.stickToken;
    return out;
  }

  /**
   * Long-polls. `drop` is null when the server has nothing (204). `skipped` names zones with work
   * waiting that this stick can't run, and what it lacks for each.
   */
  async lease(freeSlots: number): Promise<{ drop: DropPayload | null; skipped: LeaseSkip[] }> {
    const res = await this.req('/api/sticks/lease', { freeSlots, ...this.info });
    const skipped = skippedOf(res);
    if (res.status === 204) return { drop: null, skipped };
    // A refusal's body is the server's error JSON, never a payload: safe to show.
    if (!res.ok) throw await failure('lease', res);
    const parsed = DropPayloadSchema.safeParse(await res.json());
    // Never echo a 2xx body: it carries credentials.
    if (!parsed.success) throw new Error('lease failed: invalid lease payload');
    return { drop: parsed.data, skipped };
  }

  async heartbeat(
    dropId: string,
    epoch: number,
  ): Promise<'ok' | 'cancel' | 'hard_cancel' | 'stale'> {
    // A hung server must count as a failed beat, or a stick cut off from it never fences itself.
    const res = await this.req(
      `/api/drops/${dropId}/heartbeat`,
      { epoch },
      true,
      AbortSignal.timeout(this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS),
    );
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
    const out = (await res.json()) as { cancel: boolean; hard?: boolean };
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
    throw new Error(`result failed: ${last}`);
  }
}
