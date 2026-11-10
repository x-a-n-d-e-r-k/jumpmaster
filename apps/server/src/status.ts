import { listBriefings } from './briefings.js';
import type { ConfigStore } from './config/store.js';
import type { Config } from './config.js';
import type { Db } from './db/open.js';
import {
  type Drop,
  getPullRequest,
  getUsageState,
  getZoneMode,
  isKilled,
  listActiveDrops,
  listEvents,
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
import { lastPassAt } from './sync.js';
import { wizardActive } from './ui/setup.js';
import { dispatchGate, type Gate } from './usage.js';
import { type CredentialProblem, credentialProblems } from './vault/problems.js';

/**
 * The status line (§10.3): what Jumpmaster is doing and why it waits, in one headline a person
 * can repeat, the detail behind it, and the control that moves it on. `statusOf` is pure; its
 * input is built from the same decisions the system acts on (the usage gate, the credential
 * problems that park a zone, the doctor's account of a queued doctor drop, the park reasons the
 * flow wrote, the zone modes), so the line cannot say something the scheduler does not do.
 * Text is plain: the page escapes it.
 */

export type Status = {
  headline: string;
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
};

export type StatusInput = {
  setupActive: boolean;
  killed: boolean;
  killedSince?: string;
  usagePausedUntil?: string;
  /** The usage gate (dispatchGate) when it limits what starts without pausing it. */
  usageGate?: Gate;
  sticks: { live: number };
  doctor: { fails: DoctorCheck[]; finishedAt?: string };
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function elapsed(from: string | null, now: Date): string {
  if (!from) return 'starting';
  const total = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

export function statusOf(input: StatusInput, now: Date): Status {
  const pages = input.pages ?? ALL_PAGES;
  const zones = input.zones;
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

  /** The status, with what the headline left out appended to its detail. */
  const said = (s: Status, uses: { problem?: boolean; doctor?: boolean } = {}): Status => {
    const extra: string[] = [];
    if (!uses.problem)
      for (const p of problems)
        extra.push(`Also blocked: ${p.zoneId} needs ${p.credential} (${p.message}).`);
    if (!uses.doctor && fails.length > 0)
      extra.push(
        `${plural(fails.length, 'doctor fail')} (${fails.map((f) => f.id).join(', ')}) from a run ${failsAreNew ? 'after' : 'before'} the last pass.`,
      );
    if (input.restartPending) extra.push('A setting you changed takes effect at the next restart.');
    const detail = [s.detail, ...extra].filter((t) => t !== '').join(' ');
    return { ...s, detail };
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
      action: { label: 'See the sticks on home', href: '/' },
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
      detail: `After the deadline the item parks with the reason CI gave, or that it gave none.`,
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

  const problem = problems[0];
  if (problem) {
    const href = pages.credentials
      ? '/settings/credentials'
      : problem.credential === 'claudeToken'
        ? '/setup/claude'
        : '/setup/forge';
    return said(
      {
        headline: `Blocked: ${problem.zoneId} needs ${problem.credential}: ${problem.message}`,
        detail:
          problems.length > 1
            ? `${plural(problems.length, 'credential problem')} in all; the zone stays parked until each is fixed.`
            : 'The zone stays parked until it is fixed.',
        waitingOn: 'credentials',
        action: {
          label: pages.credentials ? 'Open Settings, Credentials' : 'Set it (setup step)',
          href,
        },
      },
      { problem: true },
    );
  }

  if (failsAreNew)
    return said(
      {
        headline: `Blocked: ${plural(fails.length, 'doctor fail')}, first ${fails[0]?.id}`,
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

  if (zones.length > 0 && zones.every((z) => z.mode !== 'active')) {
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

  const queued = zones.flatMap((z) =>
    z.drops.filter((d) => d.state === 'queued').map((d) => ({ z, d })),
  );
  if (queued.length > 0) {
    const why: string[] = [];
    if (input.usageGate === 'finishing_only')
      why.push("Claude's usage is above the throttle: only finishing work starts.");
    for (const z of zones)
      if (z.doctorWait && z.drops.some((d) => d.role === 'doctor' && d.state === 'queued'))
        why.push(`The doctor drop in ${z.id}: ${z.doctorWait}.`);
    return said({
      headline: `Queued: ${plural(queued.length, 'issue')}; every slot is busy`,
      detail: why.join(' '),
      waitingOn: 'stick',
    });
  }

  const zoneOne = zones.find((z) => z.mode === 'active') ?? zones[0];
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
 * The status input, read from what the system acts on: the wizard's state, the kill switch, the
 * usage gate (`dispatchGate`), the live sticks (the doctor's window), the latest doctor run, the
 * last pass, open briefings, each zone's mode, items, active drops, park reasons and credential
 * problems (the ones that park it), the doctor's account of a queued doctor drop
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
  const usage = getUsageState(db);
  const killed = isKilled(db);
  const killRow = killed
    ? (db.prepare('SELECT updated_at AS at FROM kill_switch WHERE id = 1').get() as
        | { at: string }
        | undefined)
    : undefined;
  const run = latestDoctorRun(db);
  const resolved = store?.resolved();
  const pausedUntil = gate === 'closed' ? (usage.pausedUntil ?? usage.probeNotBefore) : null;
  const last = lastPassAt();
  return {
    setupActive: store !== undefined && wizardActive(db, config),
    killed,
    ...(killRow ? { killedSince: killRow.at } : {}),
    ...(pausedUntil ? { usagePausedUntil: pausedUntil } : {}),
    usageGate: gate,
    sticks: { live: liveSticks(listSticks(db), now).length },
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
        if (d.state === 'running')
          gateEvents[d.id] = listEvents(db, d.id).filter((e) => e.kind === 'gate').length;
      const prs = items
        .filter((i) => i.state === 'pr_open')
        .flatMap((i) => {
          const pr = getPullRequest(db, i.id);
          return pr
            ? [{ workItemId: i.id, number: pr.number, headFirstSeenAt: pr.headFirstSeenAt }]
            : [];
        });
      const doctorQueued = drops.some((d) => d.role === 'doctor' && d.state === 'queued');
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
      };
    }),
    outboxRetrying: listOutbox(db, ['unknown']),
    restartPending: (store?.status().restartPending.length ?? 0) > 0,
    pages: o.pages,
  };
}
