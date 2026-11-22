import { redact } from '@jumpmaster/protocol';
import { floorBriefings, HELD_MODES } from './briefings.js';
import { getSetting, setSetting } from './config/revisions.js';
import type { ConfigStore } from './config/store.js';
import { type Config, DEFAULT_READY_LABEL } from './config.js';
import type { Db } from './db/open.js';
import {
  type Drop,
  getPullRequest,
  getUsageState,
  getZoneMode,
  isKilled,
  listActiveDrops,
  listOutbox,
  listSticks,
  listWorkItems,
  type OutboxRow,
  type WorkItem,
  type ZoneMode,
} from './db/repo.js';
import type { Pages } from './doctor/actions.js';
import { type DoctorCheck, doctorDropWait, liveSticks } from './doctor/checks.js';
import { latestDoctorRun } from './doctor/run.js';
import { isReservationReason } from './flow/decide.js';
import { listGoalChanges } from './goal-change.js';
import { missingFor, zoneRequirements } from './leases.js';
import { isBlocked, isOverlapReason, openPrCap } from './scheduler.js';
import { redactionList } from './scrub.js';
import {
  goalConfirmHref,
  PROJECTS_HREF,
  projectHref,
  SYSTEM_CREDENTIALS_HREF,
  SYSTEM_HREF,
} from './ui/links.js';
import { wizardActive } from './ui/setup.js';
import { dispatchGate, type Gate } from './usage.js';
import { type CredentialProblem, credentialProblems } from './vault/problems.js';

/**
 * The status line (§10.3): what Jumpmaster is doing and why it waits, in one headline a person
 * can repeat, the detail behind it, the other things that block it (each with its fix), and the
 * control that moves it on. `statusOf` is pure; its input is built from the same decisions the
 * system acts on (the usage gate and its row, the credential problems that park a zone, the
 * doctor's account of a queued doctor drop, the stick capabilities the lease route checks, the
 * park reasons the flow wrote, the zone modes), so the line cannot say something the scheduler
 * does not do. Text is plain, with `code` in backticks: the page escapes it and renders code,
 * `ctl status` strips the backticks.
 */

export type Status = {
  headline: string;
  /**
   * The part of the headline that changes with the clock alone (an elapsed time, minutes on CI),
   * so the Floor's live script can ignore it. Its last occurrence in the headline is the one.
   */
  volatile?: string;
  /** What the headline's state means, and nothing else. */
  detail: string;
  waitingOn:
    | 'nothing'
    | 'you'
    | 'ci'
    | 'forge'
    | 'claude'
    | 'stick'
    | 'setup'
    | 'doctor'
    | 'credentials';
  since?: string;
  action?: { label: string; href: string };
  /** Every other blocker, short, each with the page that fixes it. */
  also?: { text: string; href?: string }[];
};

/** The usage gate (dispatchGate) and the usage row's facts its holds are told by. */
export type UsageFacts = {
  gate: Gate;
  overageDropId?: string;
  overageStoppedAt?: string;
  overageUntil?: string;
  overageResumeUntil?: string;
  overageResumeWorkItemId?: number;
  overageProbeSince?: string;
};

/** One zone as the status reads it. The optional facts serve the headlines that name them. */
export type StatusZone = {
  id: string;
  mode: ZoneMode;
  items: WorkItem[];
  /** The zone's active drops (queued, leased, running). */
  drops: Drop[];
  parked: number;
  credentialProblems: CredentialProblem[];
  repo?: string;
  /** The label that queues an issue in the zone (`readyLabel`). */
  readyLabel?: string;
  ciDeadlineMinutes?: number;
  /** How many gates the zone's drops run. */
  gateCount?: number;
  /** Gate results each running drop has reported so far, by drop id. */
  gateEvents?: Record<string, number>;
  /** Open PRs and when their head was first seen (the CI deadline's anchor). */
  prs?: { workItemId: number; number: number; headFirstSeenAt: string }[];
  /** Why the zone's queued doctor drop has not started (doctorDropWait). */
  doctorWait?: string;
  /** Set when no live stick can run the zone's drops: what they lack (the lease route's check). */
  cannotRun?: string;
  /** The zone's open PR cap (`maxOpenPrs`); absent: no cap. */
  maxOpenPrs?: number;
};

export type StatusInput = {
  setupActive: boolean;
  killed: boolean;
  killedSince?: string;
  usagePausedUntil?: string;
  /** The usage gate and the row's facts (default: open). */
  usage?: UsageFacts;
  /** Live sticks, their slots, and the slots leased or running now. */
  sticks: { live: number; slots?: number; busy?: number };
  doctor: { fails: DoctorCheck[]; finishedAt?: string };
  /** The end of the last pass (stamped in the database); undefined before the first. */
  lastPassAt?: string;
  /** Open briefings the floor lists: a paused or observing zone's are held off it. */
  openBriefings: number;
  /** The viewing session's unexpired pending guarded changes (#507); none for a token. */
  pendingChanges?: number;
  /**
   * Goal changes open as their PR, waiting for Command to approve and merge them in the browser
   * (#645): configured zones that are neither paused nor observing, from the `goal_changes`
   * table only. `since` is the row's last update. Default: none.
   */
  goalChangesToConfirm?: { zoneId: string; id: number; prNumber: number | null; since: string }[];
  zones: StatusZone[];
  outboxRetrying: OutboxRow[];
  restartPending: boolean;
  /** Which pages exist (pagesOf): links fall back while a page is missing. Default: all. */
  pages?: Pages;
  /**
   * How a line names a zone to its reader, as plain text. Default: the zone id, as `ctl status`
   * shows it; the UI passes the repository name (ui/zone-name.ts). Links keep the id.
   */
  zoneName?: (id: string) => string;
};

const ALL_PAGES: Pages = { zones: true, settings: true, credentials: true };
const ACTIVE = new Set(['leased', 'running']);
/** The roles that still lease under the throttle (leases.ts FINISHING). */
const FINISHING = new Set(['review', 'heal', 'resolve']);
/** How a held zone's mode reads in a line. */
const HELD_WORD: Record<string, string> = { paused: 'paused', observe: 'observing' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "1 issue waits", "2 issues wait". */
const wait = (n: number, word: string) => `${plural(n, word)} wait${n === 1 ? 's' : ''}`;

/** A credential as a person names it, for the short list. */
const CREDENTIAL_WORDS: Record<string, string> = {
  claudeToken: 'Claude token',
  githubAuthorToken: 'author token',
  githubReviewerToken: 'reviewer token',
  githubReadToken: 'read token',
  registryReadToken: 'registry read token',
};
const credentialWords = (name: string) =>
  CREDENTIAL_WORDS[name] ?? `gate secret ${name.split(':').at(-1)}`;

/** "demo: no Claude token": the short form of a credential problem. */
function shortProblem(p: CredentialProblem, name: (id: string) => string): string {
  const what = credentialWords(p.credential);
  const zone = name(p.zoneId);
  if (p.kind === 'missing') return `${zone}: no ${what}`;
  if (p.kind === 'kind') return `${zone}: the ${what} is the wrong kind`;
  return `${zone}: the ${what} is the same as another`;
}

function elapsed(from: string | null, now: Date): string {
  if (!from) return 'starting';
  const total = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

export function statusOf(input: StatusInput, now: Date): Status {
  const pages = input.pages ?? ALL_PAGES;
  const name = input.zoneName ?? ((id: string) => id);
  const zones = input.zones;
  const usage = input.usage ?? { gate: 'open' };
  const problems = zones.flatMap((z) => z.credentialProblems);
  const fails = input.doctor.fails;
  const failsAreNew =
    fails.length > 0 &&
    (input.lastPassAt === undefined ||
      (input.doctor.finishedAt !== undefined &&
        Date.parse(input.doctor.finishedAt) > Date.parse(input.lastPassAt)));
  const working = zones.flatMap((z) =>
    z.drops.filter((d) => ACTIVE.has(d.state)).map((d) => ({ z, d })),
  );
  const credentialsHref = (p: CredentialProblem) =>
    pages.credentials
      ? SYSTEM_CREDENTIALS_HREF
      : p.credential === 'claudeToken'
        ? '/setup/claude'
        : '/setup/forge';
  const zoneHref = (id: string) => (pages.zones ? projectHref(id) : '/');
  const activeZones = zones.filter((z) => z.mode === 'active');
  // Work the next pass would take: ready items the scheduler does not skip as blocked, in active
  // zones not parked for a credential (a paused or parked zone's work is held by that, not the gate).
  const heldZones = activeZones.filter((z) => z.credentialProblems.length === 0);
  // A ready item an open PR overlaps (its reason says which, #291) is skipped like a blocked one.
  const startable = (z: StatusZone) =>
    z.items.filter((i) => i.state === 'ready' && !isBlocked(i) && !isOverlapReason(i.reason));
  // A zone at its open PR cap starts no implement drop (#291): its ready items wait on that.
  const capOf = (z: StatusZone) =>
    openPrCap(z, z.items.filter((i) => i.state === 'pr_open').length);
  const capped = heldZones.flatMap((z) => {
    const cap = capOf(z);
    const n = startable(z).length;
    return cap !== null && n > 0 ? [{ z, cap, n }] : [];
  });
  const readyCount = heldZones.reduce(
    (n, z) => n + (capOf(z) === null ? startable(z).length : 0),
    0,
  );
  const overlapReady = activeZones.flatMap((z) =>
    z.items.filter((i) => i.state === 'ready' && !isBlocked(i) && isOverlapReason(i.reason)),
  );
  const blockedReady = activeZones.flatMap((z) =>
    z.items.filter((i) => i.state === 'ready' && isBlocked(i)),
  );
  const queued = activeZones.flatMap((z) =>
    z.drops.filter((d) => d.state === 'queued').map((d) => ({ z, d })),
  );
  const heldQueued = queued.filter((q) => heldZones.includes(q.z));
  const queuedIssues = heldQueued.filter((q) => q.d.workItemId !== null).length;
  // Under the throttle only finishing roles and the doctor lease (leases.ts): the rest waits.
  const throttled = heldQueued.filter((q) => !FINISHING.has(q.d.role) && q.d.role !== 'doctor');
  const goalChanges = input.goalChangesToConfirm ?? [];
  const goalText = `${plural(goalChanges.length, 'goal change')} to confirm`;
  // The oldest change (the lowest id) is the one a link opens.
  const oldestGoalChange = goalChanges.reduce<number | undefined>(
    (m, c) => (m === undefined || c.id < m ? c.id : m),
    undefined,
  );

  /** The status, with every other blocker listed short, each with its fix. */
  const said = (
    s: Status,
    uses: {
      problem?: CredentialProblem;
      doctor?: boolean;
      cap?: boolean;
      goalChanges?: boolean;
    } = {},
  ) => {
    const also: NonNullable<Status['also']> = [];
    if (!uses.goalChanges && oldestGoalChange !== undefined)
      also.push({ text: goalText, href: goalConfirmHref(oldestGoalChange) });
    if (!uses.cap)
      for (const c of capped)
        also.push({ text: `${name(c.z.id)}: ${c.cap}`, href: zoneHref(c.z.id) });
    for (const p of problems)
      if (p !== uses.problem) also.push({ text: shortProblem(p, name), href: credentialsHref(p) });
    if (!uses.doctor && fails.length > 0)
      also.push({
        text: `${plural(fails.length, 'doctor fail')} (${fails.map((f) => f.id).join(', ')}), from a run ${failsAreNew ? 'after' : 'before'} the last pass`,
        href: SYSTEM_HREF,
      });
    // A paused zone among active ones (every zone paused is a headline of its own).
    if (activeZones.length > 0)
      for (const z of zones)
        if (z.mode !== 'active')
          also.push({
            text: `${name(z.id)} is ${z.mode === 'observe' ? 'observing' : z.mode}`,
            href: zoneHref(z.id),
          });
    if (input.restartPending) also.push({ text: 'a setting takes effect at the next restart' });
    if (input.lastPassAt === undefined) also.push({ text: 'no pass yet since start' });
    return also.length > 0 ? { ...s, also } : s;
  };

  if (input.setupActive)
    return said({
      headline: 'Finish setup',
      detail: 'Connect Claude and GitHub, check the runner, add a project and run the doctor.',
      waitingOn: 'setup',
      action: { label: 'Continue setup', href: '/setup' },
    });

  if (input.killed)
    return said({
      headline: input.killedSince
        ? `Stopped by the kill switch since ${input.killedSince}`
        : 'Stopped by the kill switch',
      detail: 'No work runs and no forge writes happen until you reset it.',
      waitingOn: 'you',
      ...(input.killedSince ? { since: input.killedSince } : {}),
      action: { label: 'Reset it on home', href: '/' },
    });

  // The credits stop: the usage gate's strongest state, and the one with a cost (credits.ts).
  if (usage.gate === 'stopped')
    return said({
      headline: `Stopped: drop ${usage.overageDropId ?? '?'} ran on usage credits at ${usage.overageStoppedAt ?? '?'}; nothing new runs until you rule on the credits briefing or the window resets at ${usage.overageUntil ?? '?'}`,
      detail:
        'Nothing leases, reviews included. The briefing offers two rulings: Run on credits now (work resumes, spending credits, until the window resets), or Noted (wait for the reset).',
      waitingOn: 'you',
      ...(usage.overageStoppedAt ? { since: usage.overageStoppedAt } : {}),
      action: { label: 'Rule on it', href: '/briefings' },
    });

  if (input.usagePausedUntil)
    return said({
      headline: `Paused by Claude's usage limit until ${input.usagePausedUntil}`,
      detail: 'Work resumes on its own then; the usage section on home has the numbers.',
      waitingOn: 'claude',
      action: { label: 'See usage on home', href: '/' },
    });

  if (input.sticks.live === 0)
    return said({
      headline: "No runner: the stick hasn't checked in",
      detail:
        'No stick has asked for work in the last two minutes: check `docker compose logs stick`.',
      waitingOn: 'stick',
      action: { label: 'See the sticks on home', href: '/#sticks' },
    });

  const first = working.sort(
    (a, b) =>
      Date.parse(a.d.startedAt ?? a.d.createdAt) - Date.parse(b.d.startedAt ?? b.d.createdAt),
  )[0];
  if (first) {
    const { z, d } = first;
    const issue = z.items.find((i) => i.id === d.workItemId)?.issueNumber;
    const n = z.gateCount ?? 0;
    const k = z.gateEvents?.[d.id] ?? 0;
    const more = working.length - 1;
    const took = elapsed(d.startedAt, now);
    return said({
      headline: `Working: ${d.role}${issue !== undefined ? ` #${issue}` : ''} in ${name(z.id)}, ${took}${n > 0 ? `, gate ${k} of ${n}` : ''}`,
      volatile: took,
      detail: more > 0 ? `${plural(more, 'more drop')} running.` : '',
      waitingOn: 'nothing',
      ...(d.startedAt ? { since: d.startedAt } : {}),
      action: { label: 'Watch the drop', href: `/drops/${encodeURIComponent(d.id)}` },
    });
  }

  // CI: an open PR none of the zone's drops is working on, oldest head first.
  const open = zones
    .flatMap((z) =>
      (z.prs ?? [])
        .filter((p) => {
          const it = z.items.find((i) => i.id === p.workItemId);
          return it?.state === 'pr_open' && !z.drops.some((d) => d.workItemId === p.workItemId);
        })
        .map((p) => ({ z, p })),
    )
    .sort((a, b) => Date.parse(a.p.headFirstSeenAt) - Date.parse(b.p.headFirstSeenAt));
  // The flow's own words for a PR held back by an older approved PR's merge reservation.
  const reservedReason = (z: StatusZone, workItemId: number): string | null => {
    const reason = z.items.find((i) => i.id === workItemId)?.reason ?? null;
    return isReservationReason(reason) ? reason : null;
  };
  const prHref = (z: StatusZone, n: number) => `https://github.com/${z.repo}/pull/${n}`;
  const ci = open[0];
  if (ci) {
    const { z, p } = ci;
    const m = Math.floor((now.getTime() - Date.parse(p.headFirstSeenAt)) / 60_000);
    const reason = reservedReason(z, p.workItemId);
    const reserved = reason !== null;
    // Every other PR waiting on a reservation is listed, so each says whose merge it waits for.
    const reservedOut = open.slice(1).flatMap(({ z: oz, p: op }) => {
      const r = reservedReason(oz, op.workItemId);
      return r === null
        ? []
        : [
            {
              text: `PR #${op.number} is ${r}`,
              ...(oz.repo ? { href: prHref(oz, op.number) } : {}),
            },
          ];
    });
    const minutes = `(${m} of ${z.ciDeadlineMinutes ?? '?'} min)`;
    const st = said({
      headline: reserved
        ? `PR #${p.number} is ${reason}`
        : `Waiting on CI for PR #${p.number} ${minutes}`,
      ...(reserved ? {} : { volatile: minutes }),
      detail: reserved
        ? 'An older approved PR is waiting on CI and holds the next merge; this one merges after it, or once that reservation lapses.'
        : 'After the deadline the item parks with the reason CI gave, or that it gave none.',
      waitingOn: 'ci',
      since: p.headFirstSeenAt,
      ...(z.repo
        ? {
            action: {
              label: `Open PR #${p.number}`,
              href: prHref(z, p.number),
            },
          }
        : {}),
    });
    return reservedOut.length > 0 ? { ...st, also: [...reservedOut, ...(st.also ?? [])] } : st;
  }

  // Held by the usage gate: work waits that the gate, not a slot, keeps from starting. The words
  // are doctorDropWait's and the home page's credits line.
  const waiting = readyCount + queuedIssues;
  const underThrottle = readyCount + throttled.length;
  if (underThrottle > 0 && usage.gate === 'finishing_only')
    return said({
      headline: `Held by Claude's usage throttle: ${wait(underThrottle, throttled.every((q) => q.d.workItemId !== null) ? 'issue' : 'drop')}; only finishing work starts`,
      detail:
        "Claude's usage is above the throttle: reviews, heals and merges go on; new work starts once usage falls back.",
      waitingOn: 'claude',
      action: { label: 'See usage on home', href: '/' },
    });
  if (waiting > 0 && usage.gate === 'probe')
    return said({
      headline: `Probing the usage limit: one drop runs until it shows the limit cleared; ${wait(waiting, 'issue')}`,
      detail: usage.overageProbeSince
        ? `The credits stop ended at ${usage.overageProbeSince}; one drop runs until a drop reports running in plan.`
        : 'The usage limit was hit; one drop runs until it shows the limit cleared, then the rest start.',
      waitingOn: 'claude',
      action: { label: 'See usage on home', href: '/' },
    });
  if (waiting > 0 && usage.gate === 'credits_resume') {
    const item = zones.flatMap((z) => z.items).find((i) => i.id === usage.overageResumeWorkItemId);
    return said({
      headline: `Resuming after a credits stop: only ${item ? `#${item.issueNumber}` : `work item ${usage.overageResumeWorkItemId ?? '?'}`} runs until ${usage.overageResumeUntil ?? '?'}`,
      detail: "You ruled Run on credits: only the resumed work item's drops lease until then.",
      waitingOn: 'claude',
      action: { label: 'See usage on home', href: '/' },
    });
  }

  const problem = problems[0];
  if (problem) {
    return said(
      {
        headline: `Blocked: ${name(problem.zoneId)} needs ${problem.credential}: ${problem.message}`,
        detail: 'The zone stays parked until it is fixed.',
        waitingOn: 'credentials',
        action: {
          label: pages.credentials ? 'Open System, Credentials' : 'Set it (setup step)',
          href: credentialsHref(problem),
        },
      },
      { problem },
    );
  }

  if (failsAreNew)
    return said(
      {
        headline: `${plural(fails.length, 'doctor fail')}, first ${fails[0]?.id}`,
        detail: 'Each fail links to the control that fixes it.',
        waitingOn: 'doctor',
        ...(input.doctor.finishedAt ? { since: input.doctor.finishedAt } : {}),
        action: { label: 'Open Health', href: SYSTEM_HREF },
      },
      { doctor: true },
    );

  const pendingChanges = input.pendingChanges ?? 0;
  if (input.openBriefings > 0 || pendingChanges > 0 || oldestGoalChange !== undefined) {
    const what = [
      input.openBriefings > 0 ? plural(input.openBriefings, 'briefing') : '',
      pendingChanges > 0 ? `${plural(pendingChanges, 'guarded change')} to confirm` : '',
      oldestGoalChange !== undefined ? goalText : '',
    ].filter((w) => w !== '');
    return said(
      {
        headline: `Waiting on you: ${what.join(', ')}`,
        detail:
          input.openBriefings > 0
            ? 'Work they hold waits for your ruling.'
            : pendingChanges > 0
              ? 'A guarded change lapses unless you confirm it in time.'
              : 'Work under the objectives it adds waits until you approve and merge it.',
        waitingOn: 'you',
        action:
          input.openBriefings > 0
            ? { label: 'Answer them', href: '/briefings' }
            : pendingChanges > 0 || oldestGoalChange === undefined
              ? { label: 'Review them on home', href: '/' }
              : { label: 'Approve and merge', href: goalConfirmHref(oldestGoalChange) },
      },
      { goalChanges: true },
    );
  }

  if (zones.length > 0 && activeZones.length === 0) {
    const draining = zones
      .filter((z) => z.drops.length > 0)
      .map((z) => `${name(z.id)} is still draining ${plural(z.drops.length, 'drop')}.`);
    return said({
      headline: `Paused by you: ${zones.map((z) => `${name(z.id)} (${z.mode})`).join(', ')}`,
      detail: draining.join(' '),
      waitingOn: 'you',
      action: { label: 'Open the zones', href: pages.zones ? PROJECTS_HREF : '/' },
    });
  }

  const retrying = input.outboxRetrying[0];
  if (retrying)
    return said({
      headline: `Retrying a GitHub call: ${retrying.kind} in ${name(retrying.zoneId)}`,
      detail:
        'Its outcome is unknown; Jumpmaster reads GitHub back before it writes again, so nothing is done twice.',
      waitingOn: 'forge',
      since: retrying.createdAt,
      action: { label: 'See the outbox on home', href: '/' },
    });

  const parkedTotal = zones.reduce((n, z) => n + z.parked, 0);
  if (parkedTotal > 0) {
    const reason =
      zones.flatMap((z) => z.items).find((i) => i.state === 'parked')?.reason ?? 'see home';
    return said({
      headline: `${parkedTotal} parked: ${reason}`,
      detail: 'A parked item waits for you: fix the cause, then add the retry label to the issue.',
      waitingOn: 'you',
      action: { label: 'See the items on home', href: '/' },
    });
  }

  if (queued.length > 0) {
    // What holds it, in the lease route's order (doctorDropWait's): the gate was open above, so
    // a stick that can run the zone, then a free slot.
    const what = queuedIssues === queued.length ? 'issue' : 'drop';
    const count = plural(queued.length, what);
    const cannot = queued.find((q) => q.z.cannotRun)?.z;
    const slots = input.sticks.slots ?? 0;
    const busy = input.sticks.busy ?? 0;
    const hold = cannot
      ? `no stick can run zone ${name(cannot.id)}: ${cannot.cannotRun}`
      : slots > 0 && busy >= slots
        ? 'every slot is busy'
        : 'it starts when a stick next asks for work';
    const why = zones
      .filter(
        (z) => z.doctorWait && z.drops.some((d) => d.role === 'doctor' && d.state === 'queued'),
      )
      .map((z) => `The doctor drop in ${name(z.id)}: ${z.doctorWait}.`);
    return said({
      headline: `Queued: ${count}; ${hold}`,
      detail: why.join(' '),
      waitingOn: 'stick',
    });
  }

  if (readyCount > 0)
    return said({
      headline: `${plural(readyCount, 'ready issue')} wait${readyCount === 1 ? 's' : ''} for the next pass`,
      detail: 'Each pass starts the ready issues a slot and the usage gate allow.',
      waitingOn: 'nothing',
    });

  // Ready, but the zone has as many open PRs as its cap allows (#291).
  if (capped.length > 0) {
    const n = capped.reduce((k, c) => k + c.n, 0);
    return said(
      {
        headline: `${wait(n, 'ready issue')}: ${capped.map((c) => `${name(c.z.id)} is ${c.cap}`).join('; ')}`,
        detail: 'The zone starts no new implement drop until an open PR merges or closes.',
        waitingOn: 'nothing',
      },
      { cap: true },
    );
  }

  // Ready, but an open PR changes a file its Placement names (#291): the pass skips it.
  if (overlapReady.length > 0) {
    const n = overlapReady.length;
    const each = overlapReady.map((i) => `#${i.issueNumber}: ${i.reason}`).join('; ');
    return said({
      headline: `${wait(n, 'ready issue')} on ${n === 1 ? 'an open PR' : 'open PRs'} that change${n === 1 ? 's' : ''} the same files (${each})`,
      detail: 'Each starts once the open PR it overlaps merges or closes.',
      waitingOn: 'nothing',
    });
  }

  // Ready, but each waits on an open issue it is blocked by: the pass skips it (isBlocked).
  if (blockedReady.length > 0) {
    const by = [...new Set(blockedReady.flatMap((i) => i.blockedBy))];
    const n = blockedReady.length;
    return said({
      headline: `${plural(n, 'ready issue')} wait${n === 1 ? 's' : ''} on the issues ${n === 1 ? 'it is' : 'they are'} blocked by (${by.join(', ')})`,
      detail: 'Each starts once the issues blocking it are closed.',
      waitingOn: 'nothing',
    });
  }

  // Ready, but in a paused or observing zone: nothing starts until it is resumed (#495).
  const heldReady = zones.flatMap((z) => {
    const n = HELD_MODES.has(z.mode) ? z.items.filter((i) => i.state === 'ready').length : 0;
    return n > 0 ? [{ z, n }] : [];
  });
  const firstHeld = heldReady[0]?.z;
  if (firstHeld)
    return said({
      headline: `Nothing will start: ${heldReady.map((h) => `${wait(h.n, 'ready issue')} in ${HELD_WORD[h.z.mode] ?? h.z.mode} ${name(h.z.id)}`).join(', ')}`,
      detail: 'A paused or observing zone starts nothing; resume it to start its ready issues.',
      waitingOn: 'you',
      action: { label: `Open ${name(firstHeld.id)}`, href: zoneHref(firstHeld.id) },
    });

  const zoneOne = activeZones[0] ?? zones[0];
  return said({
    headline: `Idle: no ready issues. Label one ${zoneOne?.readyLabel ?? DEFAULT_READY_LABEL} or file a new issue`,
    detail: '',
    waitingOn: 'you',
    action: zoneOne
      ? { label: 'New issue', href: projectHref(zoneOne.id, 'issues/new') }
      : { label: 'Add a project', href: pages.zones ? PROJECTS_HREF : '/setup/project' },
  });
}

/**
 * Why no live stick can run a zone, or undefined when one can: what they all lack, or what each
 * one lacks when they differ (the lease route's `missingFor`, per stick).
 */
export function cannotRunText(sticks: { name: string; missing: string[] }[]): string | undefined {
  if (sticks.length === 0 || sticks.some((s) => s.missing.length === 0)) return undefined;
  const shared = (sticks[0]?.missing ?? []).filter((m) =>
    sticks.every((s) => s.missing.includes(m)),
  );
  if (shared.length > 0) return `no live stick has ${shared.join(', ')}`;
  return `no live stick can run it (${sticks.map((s) => `${s.name} lacks ${s.missing.join(', ')}`).join('; ')})`;
}

/** Stamps the end of a pass (main.ts), so the status knows it across a restart. */
export function recordPass(db: Db, at: Date): void {
  setSetting(db, 'status.last_pass', at.toISOString(), at);
}

/** The end of the last pass, or undefined before the first. */
export function lastPassAt(db: Db): string | undefined {
  const v = getSetting(db, 'status.last_pass');
  return typeof v === 'string' ? v : undefined;
}

/**
 * The status input, read from what the system acts on: the wizard's state, the kill switch, the
 * usage gate (`dispatchGate`) and its row, the live sticks (the doctor's window) with their slots
 * and capabilities (`zoneRequirements`, `missingFor`, as the lease route checks), the latest
 * doctor run, the last pass, open briefings, each zone's mode, items, active drops, park reasons
 * and credential problems (the ones that park it), the doctor's account of a queued doctor drop
 * (`doctorDropWait`), outbox writes whose outcome is unknown, and a pending restart.
 */
export function statusInputOf(o: {
  db: Db;
  config: Config;
  store?: ConfigStore;
  now: Date;
  pages: Pages;
}): StatusInput {
  const { db, config, store, now } = o;
  const gate = dispatchGate(db, config.usage, now);
  const u = getUsageState(db);
  const killed = isKilled(db);
  const killRow = killed
    ? (db.prepare('SELECT updated_at AS at FROM kill_switch WHERE id = 1').get() as
        | { at: string }
        | undefined)
    : undefined;
  const run = latestDoctorRun(db);
  const resolved = store?.resolved();
  const pausedUntil = gate === 'closed' ? (u.pausedUntil ?? u.probeNotBefore) : null;
  const last = lastPassAt(db);
  const live = liveSticks(listSticks(db), now);
  const liveIds = live.map((s) => s.id);
  const busy =
    liveIds.length === 0
      ? 0
      : (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM drops WHERE state IN ('leased','running')
                 AND stick_id IN (${liveIds.map(() => '?').join(',')})`,
            )
            .get(...liveIds) as { n: number }
        ).n;
  const gateCount = db.prepare(
    "SELECT COUNT(*) AS n FROM drop_events WHERE drop_id = ? AND kind = 'gate'",
  );
  const opt = <K extends string, V>(k: K, v: V | null | undefined) =>
    (v === null || v === undefined ? {} : { [k]: v }) as Partial<Record<K, V>>;
  return {
    setupActive: store !== undefined && wizardActive(db, config),
    killed,
    ...(killRow ? { killedSince: killRow.at } : {}),
    ...(pausedUntil ? { usagePausedUntil: pausedUntil } : {}),
    usage: {
      gate,
      ...opt('overageDropId', u.overageDropId),
      ...opt('overageStoppedAt', u.overageStoppedAt),
      ...opt('overageUntil', u.overageUntil),
      ...opt('overageResumeUntil', u.overageResumeUntil),
      ...opt('overageResumeWorkItemId', u.overageResumeWorkItemId),
      ...opt('overageProbeSince', u.overageProbeSince),
    },
    sticks: { live: live.length, slots: live.reduce((n, s) => n + s.slots, 0), busy },
    doctor: {
      fails: run?.checks.filter((c) => c.status === 'fail') ?? [],
      ...(run?.finishedAt ? { finishedAt: run.finishedAt } : {}),
    },
    ...(last ? { lastPassAt: last } : {}),
    // A paused or observing zone's briefings are held off the floor, so they don't count here.
    openBriefings: floorBriefings(db, config.dropZones).listed.length,
    goalChangesToConfirm: goalChangesToConfirm(db, config),
    zones: config.dropZones.map((zone): StatusZone => {
      const items = listWorkItems(db, zone.id);
      const drops = listActiveDrops(db, zone.id);
      const gateEvents: Record<string, number> = {};
      for (const d of drops)
        if (d.state === 'running') gateEvents[d.id] = (gateCount.get(d.id) as { n: number }).n;
      const prs = items
        .filter((i) => i.state === 'pr_open')
        .flatMap((i) => {
          const pr = getPullRequest(db, i.id);
          return pr
            ? [{ workItemId: i.id, number: pr.number, headFirstSeenAt: pr.headFirstSeenAt }]
            : [];
        });
      const doctorQueued = drops.some((d) => d.role === 'doctor' && d.state === 'queued');
      const need = zoneRequirements(zone, config);
      const cannotRun =
        live.length > 0
          ? cannotRunText(live.map((s) => ({ name: s.name, missing: missingFor(s, need) })))
          : undefined;
      return {
        id: zone.id,
        mode: getZoneMode(db, zone.id, zone.mode),
        items,
        drops,
        parked: items.filter((i) => i.state === 'parked').length,
        credentialProblems: resolved
          ? credentialProblems(zone, resolved, store?.resolvedApps())
          : [],
        repo: zone.repo,
        readyLabel: zone.readyLabel,
        ciDeadlineMinutes: zone.ciDeadlineMinutes,
        gateCount: zone.gates.length,
        gateEvents,
        prs,
        ...(doctorQueued ? { doctorWait: doctorDropWait(db, config, zone, now) } : {}),
        ...(cannotRun ? { cannotRun } : {}),
        ...(zone.maxOpenPrs !== undefined ? { maxOpenPrs: zone.maxOpenPrs } : {}),
      };
    }),
    outboxRetrying: listOutbox(db, ['unknown']),
    restartPending: (store?.status().restartPending.length ?? 0) > 0,
    pages: o.pages,
  };
}

/**
 * The goal changes open as their PR (#645), oldest first, from the `goal_changes` table only:
 * configured zones only, and none of a paused or observing zone's, as its briefings are held,
 * since nothing merges there until the zone is active again.
 */
function goalChangesToConfirm(
  db: Db,
  config: Config,
): NonNullable<StatusInput['goalChangesToConfirm']> {
  const active = config.dropZones.filter((z) => !HELD_MODES.has(getZoneMode(db, z.id, z.mode)));
  return active
    .flatMap((z) =>
      listGoalChanges(db, z.id, 'open').map((c) => ({
        zoneId: z.id,
        id: c.id,
        prNumber: c.prNumber,
        since: c.updatedAt,
      })),
    )
    .sort((a, b) => a.id - b.id);
}

/** Every string of a status with the install's secrets redacted. */
function redactStatus(s: Status, secrets: string[]): Status {
  const r = (t: string) => redact(t, secrets);
  return {
    ...s,
    headline: r(s.headline),
    ...(s.volatile !== undefined ? { volatile: r(s.volatile) } : {}),
    detail: r(s.detail),
    ...(s.since ? { since: r(s.since) } : {}),
    ...(s.action ? { action: { label: r(s.action.label), href: r(s.action.href) } } : {}),
    ...(s.also
      ? {
          also: s.also.map((a) => ({
            text: r(a.text),
            ...(a.href ? { href: r(a.href) } : {}),
          })),
        }
      : {}),
  };
}

/**
 * The status the home page and `GET /api/control/status` show: built once, here, and redacted
 * of the install's secrets and the scrub set's values so no future reason text can carry one.
 */
export function buildStatus(
  o: Parameters<typeof statusInputOf>[0] & {
    zoneName?: (id: string) => string;
    /** The viewing session's pending guarded changes (#507). */
    pendingChanges?: number;
  },
): Status {
  const base = statusInputOf(o);
  const input = o.pendingChanges ? { ...base, pendingChanges: o.pendingChanges } : base;
  return redactStatus(
    statusOf(o.zoneName ? { ...input, zoneName: o.zoneName } : input, o.now),
    redactionList(o.config.secrets),
  );
}
