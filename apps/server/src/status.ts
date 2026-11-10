import { redact } from '@jumpmaster/protocol';
import { listBriefings } from './briefings.js';
import { getSetting, setSetting } from './config/revisions.js';
import type { ConfigStore } from './config/store.js';
import { type Config, secretList } from './config.js';
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
import { missingFor, zoneRequirements } from './leases.js';
import { isBlocked } from './scheduler.js';
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
  openBriefings: number;
  zones: StatusZone[];
  outboxRetrying: OutboxRow[];
  restartPending: boolean;
  /** Which pages exist (pagesOf): links fall back while a page is missing. Default: all. */
  pages?: Pages;
};

const ALL_PAGES: Pages = { zones: true, settings: true, credentials: true };
const ACTIVE = new Set(['leased', 'running']);
/** The roles that still lease under the throttle (leases.ts FINISHING). */
const FINISHING = new Set(['review', 'heal', 'resolve']);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "1 issue waits", "2 issues wait". */
const wait = (n: number, word: string) => `${plural(n, word)} wait${n === 1 ? 's' : ''}`;

/** A credential as a person names it, for the short list. */
const CREDENTIAL_WORDS: Record<string, string> = {
  claudeToken: 'Claude token',
  githubAuthorToken: 'author token',
  githubReviewerToken: 'reviewer token',
  githubReadToken: 'read token',
};
const credentialWords = (name: string) =>
  CREDENTIAL_WORDS[name] ?? `gate secret ${name.split(':').at(-1)}`;

/** "demo: no Claude token": the short form of a credential problem. */
function shortProblem(p: CredentialProblem): string {
  const what = credentialWords(p.credential);
  if (p.kind === 'missing') return `${p.zoneId}: no ${what}`;
  if (p.kind === 'kind') return `${p.zoneId}: the ${what} is the wrong kind`;
  return `${p.zoneId}: the ${what} is the same as another`;
}

function elapsed(from: string | null, now: Date): string {
  if (!from) return 'starting';
  const total = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

export function statusOf(input: StatusInput, now: Date): Status {
  const pages = input.pages ?? ALL_PAGES;
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
      ? '/settings/credentials'
      : p.credential === 'claudeToken'
        ? '/setup/claude'
        : '/setup/forge';
  const zoneHref = (id: string) => (pages.zones ? `/zones/${encodeURIComponent(id)}` : '/');
  const activeZones = zones.filter((z) => z.mode === 'active');
  // Work the next pass would take: ready items the scheduler does not skip as blocked, in active
  // zones not parked for a credential (a paused or parked zone's work is held by that, not the gate).
  const heldZones = activeZones.filter((z) => z.credentialProblems.length === 0);
  const readyCount = heldZones.reduce(
    (n, z) => n + z.items.filter((i) => i.state === 'ready' && !isBlocked(i)).length,
    0,
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

  /** The status, with every other blocker listed short, each with its fix. */
  const said = (s: Status, uses: { problem?: CredentialProblem; doctor?: boolean } = {}) => {
    const also: NonNullable<Status['also']> = [];
    for (const p of problems)
      if (p !== uses.problem) also.push({ text: shortProblem(p), href: credentialsHref(p) });
    if (!uses.doctor && fails.length > 0)
      also.push({
        text: `${plural(fails.length, 'doctor fail')} (${fails.map((f) => f.id).join(', ')}), from a run ${failsAreNew ? 'after' : 'before'} the last pass`,
        href: '/doctor',
      });
    // A paused zone among active ones (every zone paused is a headline of its own).
    if (activeZones.length > 0)
      for (const z of zones)
        if (z.mode !== 'active')
          also.push({
            text: `${z.id} is ${z.mode === 'observe' ? 'observing' : z.mode}`,
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
    return said({
      headline: `Working: ${d.role}${issue !== undefined ? ` #${issue}` : ''} in ${z.id}, ${elapsed(d.startedAt, now)}${n > 0 ? `, gate ${k} of ${n}` : ''}`,
      detail: more > 0 ? `${plural(more, 'more drop')} running.` : '',
      waitingOn: 'nothing',
      ...(d.startedAt ? { since: d.startedAt } : {}),
      action: { label: 'Watch the drop', href: `/drops/${encodeURIComponent(d.id)}` },
    });
  }

  // CI: an open PR none of the zone's drops is working on, oldest head first.
  const ci = zones
    .flatMap((z) =>
      (z.prs ?? [])
        .filter((p) => {
          const it = z.items.find((i) => i.id === p.workItemId);
          return it?.state === 'pr_open' && !z.drops.some((d) => d.workItemId === p.workItemId);
        })
        .map((p) => ({ z, p })),
    )
    .sort((a, b) => Date.parse(a.p.headFirstSeenAt) - Date.parse(b.p.headFirstSeenAt))[0];
  if (ci) {
    const { z, p } = ci;
    const m = Math.floor((now.getTime() - Date.parse(p.headFirstSeenAt)) / 60_000);
    return said({
      headline: `Waiting on CI for PR #${p.number} (${m} of ${z.ciDeadlineMinutes ?? '?'} min)`,
      detail: 'After the deadline the item parks with the reason CI gave, or that it gave none.',
      waitingOn: 'ci',
      since: p.headFirstSeenAt,
      ...(z.repo
        ? {
            action: {
              label: `Open PR #${p.number}`,
              href: `https://github.com/${z.repo}/pull/${p.number}`,
            },
          }
        : {}),
    });
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
        headline: `Blocked: ${problem.zoneId} needs ${problem.credential}: ${problem.message}`,
        detail: 'The zone stays parked until it is fixed.',
        waitingOn: 'credentials',
        action: {
          label: pages.credentials ? 'Open Settings, Credentials' : 'Set it (setup step)',
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
        action: { label: 'Open the doctor', href: '/doctor' },
      },
      { doctor: true },
    );

  if (input.openBriefings > 0)
    return said({
      headline: `Waiting on you: ${plural(input.openBriefings, 'briefing')}`,
      detail: 'Work they hold waits for your ruling.',
      waitingOn: 'you',
      action: { label: 'Answer them', href: '/briefings' },
    });

  if (zones.length > 0 && activeZones.length === 0) {
    const draining = zones
      .filter((z) => z.drops.length > 0)
      .map((z) => `${z.id} is still draining ${plural(z.drops.length, 'drop')}.`);
    return said({
      headline: `Paused by you: ${zones.map((z) => `${z.id} (${z.mode})`).join(', ')}`,
      detail: draining.join(' '),
      waitingOn: 'you',
      action: { label: 'Open the zones', href: pages.zones ? '/zones' : '/' },
    });
  }

  const retrying = input.outboxRetrying[0];
  if (retrying)
    return said({
      headline: `Retrying a GitHub call: ${retrying.kind} in ${retrying.zoneId}`,
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
      ? `no stick can run zone ${cannot.id}: ${cannot.cannotRun}`
      : slots > 0 && busy >= slots
        ? 'every slot is busy'
        : 'it starts when a stick next asks for work';
    const why = zones
      .filter(
        (z) => z.doctorWait && z.drops.some((d) => d.role === 'doctor' && d.state === 'queued'),
      )
      .map((z) => `The doctor drop in ${z.id}: ${z.doctorWait}.`);
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

  const zoneOne = activeZones[0] ?? zones[0];
  return said({
    headline: 'Idle: no ready issues. Label one agent-ready or file one from Intake',
    detail: '',
    waitingOn: 'you',
    action: zoneOne
      ? { label: 'Open Intake', href: `/zones/${encodeURIComponent(zoneOne.id)}/intake` }
      : { label: 'Add a project', href: pages.zones ? '/zones' : '/setup/project' },
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
    openBriefings: listBriefings(db, { state: 'open' }).length,
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
        credentialProblems: resolved ? credentialProblems(zone, resolved) : [],
        repo: zone.repo,
        ciDeadlineMinutes: zone.ciDeadlineMinutes,
        gateCount: zone.gates.length,
        gateEvents,
        prs,
        ...(doctorQueued ? { doctorWait: doctorDropWait(db, config, zone, now) } : {}),
        ...(cannotRun ? { cannotRun } : {}),
      };
    }),
    outboxRetrying: listOutbox(db, ['unknown']),
    restartPending: (store?.status().restartPending.length ?? 0) > 0,
    pages: o.pages,
  };
}

/** Every string of a status with the install's secrets redacted. */
function redactStatus(s: Status, secrets: string[]): Status {
  const r = (t: string) => redact(t, secrets);
  return {
    ...s,
    headline: r(s.headline),
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
 * of the install's secrets so no future reason text can carry one.
 */
export function buildStatus(o: Parameters<typeof statusInputOf>[0]): Status {
  return redactStatus(statusOf(statusInputOf(o), o.now), secretList(o.config.secrets));
}
