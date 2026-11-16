// What each stick is downloading from the image mirror (issue #141), as its lease calls report
// it: kept in memory only, and shown on /sticks while fresh. A stick reports at most every 2
// seconds while it downloads, and `null` once it is done.
import type { ImageFetch } from '@jumpmaster/protocol';

/** A report older than this is a stick that stopped talking mid-download: not shown. */
export const FETCH_SHOWN_MS = 60_000;

export class StickFetches {
  readonly #by = new Map<string, { fetch: ImageFetch; at: number }>();

  /** Records a stick's report: its download, or `null` for none. */
  set(stickId: string, fetch: ImageFetch | null, at: Date): void {
    if (fetch === null) this.#by.delete(stickId);
    else this.#by.set(stickId, { fetch, at: at.getTime() });
  }

  /** The stick's download in progress, if it reported one recently. */
  get(stickId: string, now: Date): ImageFetch | undefined {
    const e = this.#by.get(stickId);
    if (!e) return undefined;
    if (now.getTime() - e.at > FETCH_SHOWN_MS) {
      this.#by.delete(stickId);
      return undefined;
    }
    return e.fetch;
  }
}
