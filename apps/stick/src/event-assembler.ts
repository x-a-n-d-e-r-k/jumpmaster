import { EventPartSchema, type TrooperEvent, TrooperEventSchema } from '@jumpmaster/protocol';

/** The most part bytes one drop may hold before its oldest incomplete event is discarded. */
export const MAX_PENDING_EVENT_BYTES = 64 * 1024 * 1024;
/** What a part counts for at least, so a flood of tiny parts is bounded too. */
const MIN_PART_COST = 1024;

interface Pending {
  of: number;
  parts: (Buffer | undefined)[];
  have: number;
  bytes: number;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Rebuilds events the trooper sent as `JM_EVENT_PART ` lines. Each assembled event is parsed with
 * {@link TrooperEventSchema}, as a single line is; the caller applies the same rules to both.
 * What is lost (an event never completed, or discarded for the pending cap) leaves one `log` event.
 */
export class EventAssembler {
  /** By id, oldest first (a Map keeps insertion order). */
  private readonly pending = new Map<number, Pending>();
  /** Ids already discarded: their late parts are ignored. */
  private readonly dropped = new Set<number>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(opts: { maxBytes?: number; now?: () => Date } = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_PENDING_EVENT_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  /** Takes one part's JSON; returns what to queue now, in order (possibly nothing). */
  add(json: string): TrooperEvent[] {
    const parsed = EventPartSchema.safeParse(safeJson(json));
    if (!parsed.success) return [];
    const { id, n, of, chunk } = parsed.data;
    if (n > of || this.dropped.has(id)) return [];
    let p = this.pending.get(id);
    if (!p) {
      p = { of, parts: new Array<Buffer | undefined>(of), have: 0, bytes: 0 };
      this.pending.set(id, p);
    }
    if (p.of !== of || p.parts[n - 1]) return [];
    const data = Buffer.from(chunk, 'base64');
    const cost = Math.max(data.length, MIN_PART_COST);
    p.parts[n - 1] = data;
    p.have++;
    p.bytes += cost;
    this.bytes += cost;

    const out: TrooperEvent[] = [];
    while (this.bytes > this.maxBytes) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      out.push(this.discard(oldest.value));
    }
    if (this.pending.get(id) === p && p.have === p.of) {
      this.forget(id, p);
      out.push(this.decode(id, p));
    }
    return out;
  }

  /** At the trooper's exit: every incomplete event is discarded, one log each. */
  finish(): TrooperEvent[] {
    return [...this.pending.keys()].map((id) => this.discard(id));
  }

  private forget(id: number, p: Pending): void {
    this.pending.delete(id);
    this.bytes -= p.bytes;
  }

  private discard(id: number): TrooperEvent {
    const p = this.pending.get(id) as Pending;
    this.forget(id, p);
    this.dropped.add(id);
    return this.log(`event ${id} incomplete: ${p.have} of ${p.of} parts`);
  }

  private decode(id: number, p: Pending): TrooperEvent {
    const whole = Buffer.concat(p.parts as Buffer[]).toString('utf8');
    const ev = TrooperEventSchema.safeParse(safeJson(whole));
    return ev.success ? ev.data : this.log(`event ${id} unreadable`);
  }

  private log(message: string): TrooperEvent {
    return { ts: this.now().toISOString(), kind: 'log', data: { message } };
  }
}
