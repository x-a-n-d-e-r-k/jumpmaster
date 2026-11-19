// The stick's lease loop. It starts at once after startup recovery: until the first health check
// (which pulls the trooper image, minutes on a cold cache) has a result, the stick only reports in,
// with no free slot, so the server sees it alive and starting but leases it nothing (issue #157).
import type { DropPayload, StickStarting, UpgradeOffer } from '@jumpmaster/protocol';
import type { LeaseTerms, leaseLogger, StickClient } from './client.js';
import type { SlotTarget } from './slots.js';

/** How often a starting stick reports in while its first health check runs. */
export const STARTING_REPORT_MS = 30_000;
/** How long a starting stick waits after a failed report before trying again. */
const STARTING_RETRY_MS = 5_000;
/** How long a stick below the free floor waits between re-measurements. */
const FLOOR_WAIT_MS = 30_000;
/** How often a stick holding an upgrade offer asks whether it still stands (issue #430). */
export const UPGRADE_POLL_MS = 5_000;
/** How often a full stick asks the server (with no free slot) whether its trooper count changed. */
const SLOTS_POLL_MS = 10_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The stick upgrade's hold on the lease loop (issue #430, see upgrade.ts). */
export interface UpgradeControl {
  /** An offer is held: no new drop starts, and leases ask for none. */
  holding(): boolean;
  /** Each lease answer's offer (undefined: the answer carried none). */
  answered(offer: UpgradeOffer | undefined): void;
  /** Each round while holding, with the drops still running. */
  idle(running: number): void;
}

export interface LeaseLoopDeps {
  client: Pick<StickClient, 'lease' | 'reportStarting'> & {
    readonly upgradeOffer?: UpgradeOffer | undefined;
  };
  target: SlotTarget;
  /** What the next lease says (null: below the free floor, lease nothing). */
  terms: () => LeaseTerms | null;
  /** The first health check: until it settles, nothing is leased. A rejection ends the loop. */
  firstCheck: Promise<unknown>;
  /** Re-measures health (below the floor). */
  recheck: () => Promise<void>;
  /** Runs a leased drop; settles when it is done with its lease slot. */
  start: (drop: DropPayload) => Promise<void>;
  /** The trooper image the first check checks, for the starting report. */
  image: string;
  leaseLog: Pick<ReturnType<typeof leaseLogger>, 'skipped' | 'error'>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Ends the loop when true (tests). */
  stopped?: () => boolean;
  /** The stick upgrade (issue #430); absent, offers are ignored. */
  upgrade?: UpgradeControl;
}

export async function runLeaseLoop(d: LeaseLoopDeps): Promise<void> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const stopped = d.stopped ?? (() => false);
  const log = d.log ?? ((line: string) => console.log(line));
  const { client, target, leaseLog } = d;
  let asked = 0;
  /** Tells the upgrade what the latest answer offered. */
  const answered = () => d.upgrade?.answered(client.upgradeOffer);
  /** Applies the server's trooper count, saying so when the target moves. */
  const follow = (told: number | null) => {
    const before = target.target;
    target.follow(told);
    asked = now();
    if (target.target !== before) log(`troopers: now ${target.target} at once`);
  };

  // Starting: report in with no free slot, at once and every STARTING_REPORT_MS, until the first
  // check settles. The answer's trooper count applies; a drop in it is never acted on.
  let checked = false;
  const first = d.firstCheck.then(() => {
    checked = true;
  });
  // Settled either way, so a rejection is not unhandled while a report is in flight.
  first.catch(() => {});
  const starting: StickStarting = { image: d.image };
  client.reportStarting(starting);
  while (!checked && !stopped()) {
    let wait = STARTING_REPORT_MS;
    try {
      follow((await client.lease(0, d.terms() ?? {})).slots);
      answered();
    } catch (e) {
      asked = now();
      wait = STARTING_RETRY_MS;
      leaseLog.error(e instanceof Error ? e.message : String(e));
    }
    if (checked) break;
    // Rethrows a failed first check, which ends the stick as awaiting it did.
    await Promise.race([first, sleep(wait)]);
  }
  if (!checked) return;
  // The next lease says the check is done.
  client.reportStarting(null);

  let running = 0;
  while (!stopped()) {
    if (d.upgrade?.holding()) {
      // An upgrade is offered (issue #430): no new drop. Running drops, their heartbeats and
      // pending pushes go on; the upgrade acts once they are done. Each answer (no free slot)
      // says whether the offer still stands.
      d.upgrade.idle(running);
      if (now() - asked >= UPGRADE_POLL_MS) {
        try {
          follow((await client.lease(0, d.terms() ?? {})).slots);
          answered();
        } catch (e) {
          asked = now();
          leaseLog.error(e instanceof Error ? e.message : String(e));
        }
      }
      await sleep(500);
      continue;
    }
    if (target.free(running) < 1) {
      // Full: nothing running is stopped. Ask now and then, with no free slot, whether the count
      // went up, so a raise applies before a drop finishes.
      const terms = d.terms();
      if (terms && now() - asked >= SLOTS_POLL_MS) {
        try {
          follow((await client.lease(0, terms)).slots);
          answered();
        } catch (e) {
          asked = now();
          leaseLog.error(e instanceof Error ? e.message : String(e));
        }
      }
      await sleep(500);
      continue;
    }
    if (!d.terms()) {
      // Measured below the floor: look again now, so leasing resumes once space is freed.
      await d.recheck().catch(() => {});
      if (!d.terms()) await sleep(FLOOR_WAIT_MS);
      continue;
    }
    const terms = d.terms();
    if (!terms) continue;
    try {
      const { drop, skipped, slots: told } = await client.lease(target.free(running), terms);
      follow(told);
      answered();
      leaseLog.skipped(skipped);
      if (!drop) continue;
      running++;
      void d
        .start(drop)
        .catch(() => {})
        .finally(() => {
          running--;
        });
    } catch (e) {
      leaseLog.error(e instanceof Error ? e.message : String(e));
      await sleep(5000);
    }
  }
}
