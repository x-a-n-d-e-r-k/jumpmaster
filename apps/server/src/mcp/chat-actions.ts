import { containsSecret, redact } from '@jumpmaster/protocol';
import { z } from 'zod';
import {
  type ActionCtx,
  type ActionResult,
  auditAction,
  chatPrincipal,
  crewCycleAction,
  ruleAction,
  zoneModeAction,
} from '../api/operator-actions.js';
import { type QueueResult, queueIssue } from '../backlog.js';
import { getBriefing, OBJECTIVE_PREFIX, optionsDigest, raiseBriefing } from '../briefings.js';
import { type CardKind, type CardUndo, type NewCard, recordCard } from '../chat/cards.js';
import type { DropZoneConfig } from '../config.js';
import { getUsageState, getWorkItem, getZoneMode, isKilled, listWorkItems } from '../db/repo.js';
import type { IssueFacts } from '../forge/github.js';
import { getGoals, objectivesDone } from '../goals.js';
import {
  type ForgePair,
  type Op,
  runOp,
  type SetLabelsPayload,
  type UpdateIssuePayload,
} from '../outbox.js';
import { redactionList } from '../scrub.js';
import { dispatchGate } from '../usage.js';
import { type ChatToolContext, type ChatToolDef, type Outcome, ok, refused } from './kit.js';
import { type ChatPrincipal, isChatPrincipal } from './tokens.js';

/**
 * The crew chat's database-only action tools (#336, Task 13): rule a briefing, pause or resume a
 * zone, run a crew cycle and mark an objective done, each through the shared operator action the
 * browser's route calls, as the chat principal. Every call a chat principal makes to an action
 * (these, and the zone write tools `file_staged_issues` and `raise_briefing`) records one card on
 * the chat token's own thread and message, written from the server's record of what was done.
 */

/** What an action did, for its card: the server's own words, never the model's arguments. */
export type Acted = {
  out: Outcome;
  summary?: string;
  target?: string;
  link?: string;
  /** What Undo needs, where the action can be reversed. */
  undo?: CardUndo;
};

const zoneLink = (zoneId: string): string => `/zones/${encodeURIComponent(zoneId)}`;
const briefingLink = (id: number): string => `/briefings/${id}`;

/** What each kind of action is called in a refused card. */
const ACTION_WORDS: Record<CardKind, string> = {
  file_issues: 'Filing staged issues',
  briefing: 'Raising a briefing',
  rule: 'Ruling on a briefing',
  pause: 'Pausing a zone',
  resume: 'Resuming a zone',
  crew_cycle: 'Running a crew cycle',
  objective_done: 'Marking an objective done',
  queue: 'Work on it',
  retry: 'Retrying an item',
  close: 'Closing an issue',
  setting: 'Changing a setting',
  goal_change: 'Changing the goals',
};

/**
 * Why no chat action may run now: the kill switch, a usage credits stop, or a token or secret in
 * the arguments. Null when it may.
 */
export function chatActionBlocked(ctx: ChatToolContext, args: unknown): Outcome | null {
  const { db, config } = ctx;
  if (isKilled(db))
    return refused('the kill switch is engaged; nothing acts until it is released', 'killed');
  if (dispatchGate(db, config.usage, ctx.now()) === 'stopped') {
    const until = getUsageState(db).overageUntil;
    return refused(
      `a usage credits stop is in force${until ? ` until ${until}` : ''}; actions wait for it to lift`,
      'usage stopped',
    );
  }
  if (containsSecret(JSON.stringify(args), redactionList(config.secrets))) {
    return refused('the arguments contain a token or secret', 'contains secret');
  }
  return null;
}

/**
 * Runs one action for the caller. A zone principal's call just runs. A chat principal's is refused
 * by `chatActionBlocked` first, and either way records one card on its token's thread and message:
 * `done` with the action's own summary, or `refused` with the refusal's reason code (a fixed
 * vocabulary, so no text of the model's reaches the card).
 */
export function carded(
  ctx: ChatToolContext,
  kind: CardKind,
  args: unknown,
  act: () => Acted,
): Outcome {
  if (!isChatPrincipal(ctx.principal)) return act().out;
  const blocked = chatActionBlocked(ctx, args);
  return cardOf(ctx, kind, blocked ? { out: blocked } : act());
}

/** `carded` for an action that awaits the forge: an external tool's (ruling R10). */
export async function cardedAsync(
  ctx: ChatToolContext,
  kind: CardKind,
  args: unknown,
  act: () => Promise<Acted>,
): Promise<Outcome> {
  if (!isChatPrincipal(ctx.principal)) return (await act()).out;
  const blocked = chatActionBlocked(ctx, args);
  return cardOf(ctx, kind, blocked ? { out: blocked } : await act());
}

/** Records the chat principal's card for what an action did, and returns its outcome. */
function cardOf(ctx: ChatToolContext, kind: CardKind, acted: Acted): Outcome {
  const p = chatOf(ctx);
  const done = acted.out.outcome === 'ok';
  const card: NewCard = {
    threadId: p.threadId,
    messageId: p.messageId,
    kind,
    zoneId: ctx.zone?.id ?? null,
    state: done ? 'done' : 'refused',
    summary:
      done && acted.summary
        ? acted.summary
        : `${ACTION_WORDS[kind]} was refused (${acted.out.detail ?? 'refused'}).`,
    ...(done && acted.target ? { target: acted.target } : {}),
    ...(done && acted.link ? { link: acted.link } : {}),
    ...(done && acted.undo ? { undo: acted.undo } : {}),
  };
  ctx.onCard?.(recordCard(ctx.db, card, ctx.now()));
  return acted.out;
}

/** The shared actions' context for a chat principal's call. */
function actionCtx(ctx: ChatToolContext, p: ChatPrincipal): ActionCtx {
  return {
    db: ctx.db,
    now: ctx.now,
    config: ctx.config,
    principal: chatPrincipal(p),
    secrets: redactionList(ctx.config.secrets),
    ...(ctx.kick ? { kick: ctx.kick } : {}),
  };
}

/** A shared action's failure as a refusal: its error is the server's own fixed text. */
const failed = (r: Extract<ActionResult<unknown>, { ok: false }>): Acted => ({
  out: refused(r.error, r.error),
});

/** The chat principal and zone an action tool needs; callTool has checked any `zoneId`. */
function chatOf(ctx: ChatToolContext): ChatPrincipal {
  if (!isChatPrincipal(ctx.principal)) throw new Error('a chat action needs a chat principal');
  return ctx.principal;
}
const zoneNeeded = (ctx: ChatToolContext): DropZoneConfig | null => ctx.zone ?? null;

// ---------------------------------------------------------------------------------------------

const ZoneId = z.string().min(1).max(200);

const RuleArgs = z.strictObject({
  briefingId: z.number().int().positive(),
  optionId: z.string().min(1).max(100),
  note: z.string().max(2000).optional(),
});

const ruleBriefingTool: ChatToolDef = {
  name: 'rule_briefing',
  scope: 'chat-write',
  description:
    "Rules an open briefing on the owner's word: the option the owner chose, and an optional note. " +
    'Applied by the next pass, exactly as a ruling in the browser. A ruling has no Undo: ask the ' +
    'owner which option before calling this.',
  input: RuleArgs,
  run(ctx, args: z.infer<typeof RuleArgs>) {
    const p = chatOf(ctx);
    const b = getBriefing(ctx.db, args.briefingId);
    const zone = b && ctx.config.dropZones.find((z) => z.id === b.zoneId);
    return carded({ ...ctx, ...(zone ? { zone } : {}) }, 'rule', args, () => {
      if (!b || !zone) return { out: refused('unknown briefing', 'unknown briefing') };
      // The digest of the briefing as it stands: the chat rules on what the server holds now.
      const r = ruleAction(actionCtx(ctx, p), b.id, args.optionId, args.note ?? '', {
        optionsDigest: optionsDigest(b),
      });
      if (!r.ok) return failed(r);
      const option = b.options.find((o) => o.id === args.optionId);
      return {
        out: ok(`Ruled briefing ${b.id}: ruling ${r.value.rulingId}. It applies on the next pass.`),
        summary: `Ruled on "${b.decision}": ${option?.label ?? args.optionId}. It applies on the next pass.`,
        target: `briefing:${b.id}`,
        link: briefingLink(b.id),
      };
    });
  },
};

const ModeArgs = z.strictObject({ zoneId: ZoneId, mode: z.enum(['active', 'paused']) });

const setZoneModeTool: ChatToolDef = {
  name: 'set_zone_mode',
  scope: 'chat-write',
  description:
    "Pauses a zone (no new drops start; running ones finish) or makes it active again, on the owner's word.",
  input: ModeArgs,
  run(ctx, args: z.infer<typeof ModeArgs>) {
    const p = chatOf(ctx);
    return carded(ctx, args.mode === 'paused' ? 'pause' : 'resume', args, () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const r = zoneModeAction(actionCtx(ctx, p), zone.id, args.mode);
      if (!r.ok) return failed(r);
      const words = args.mode === 'paused' ? 'Paused' : 'Resumed';
      return {
        out: ok(`Zone ${zone.id} is now ${r.value.mode}.`),
        summary:
          args.mode === 'paused'
            ? `${words} zone ${zone.id}: no new drops start, running ones finish.`
            : `${words} zone ${zone.id}: it is active again.`,
        target: zone.id,
        link: zoneLink(zone.id),
      };
    });
  },
};

const ZoneArgs = z.strictObject({ zoneId: ZoneId });

const runCrewCycleTool: ChatToolDef = {
  name: 'run_crew_cycle',
  scope: 'chat-write',
  description: "Makes the zone's crew lead cycle due now, where the zone's crew is enabled.",
  input: ZoneArgs,
  run(ctx, args: z.infer<typeof ZoneArgs>) {
    const p = chatOf(ctx);
    return carded(ctx, 'crew_cycle', args, () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const r = crewCycleAction(actionCtx(ctx, p), zone.id);
      if (!r.ok) return failed(r);
      return {
        out: ok(`Zone ${zone.id}: a crew cycle is due now.`),
        summary: `Asked zone ${zone.id}'s crew lead for a cycle now.`,
        target: zone.id,
        link: zoneLink(zone.id),
      };
    });
  },
};

const ObjectiveArgs = z.strictObject({ zoneId: ZoneId, key: z.string().min(1).max(100) });

/** Whether a "Mark it done" ruling on the objective waits to be applied. */
const doneRulingWaits = (ctx: ChatToolContext, zoneId: string, key: string): boolean =>
  ctx.db
    .prepare(
      `SELECT 1 FROM rulings r JOIN briefings b ON b.id = r.briefing_id
         WHERE r.zone_id = ? AND b.subject = ? AND r.choice_effect = 'advance_objective'
           AND r.applied_at IS NULL AND r.apply_error IS NULL LIMIT 1`,
    )
    .get(zoneId, `${OBJECTIVE_PREFIX}${key}`) !== undefined;

const markObjectiveDoneTool: ChatToolDef = {
  name: 'mark_objective_done',
  scope: 'chat-write',
  description:
    "Marks one of the zone's objectives done, on the owner's word: by its key from get_goals. The " +
    'server raises its own "objective done" briefing and rules "Mark it done", applied by the next ' +
    'pass. The goal file is not changed.',
  input: ObjectiveArgs,
  run(ctx, args: z.infer<typeof ObjectiveArgs>) {
    const p = chatOf(ctx);
    return carded(ctx, 'objective_done', args, () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const goals = getGoals(ctx.db, zone.id);
      const objective = goals?.parse.ok
        ? goals.parse.objectives.find((o) => o.key === args.key)
        : undefined;
      if (!objective) {
        return { out: refused("not an objective in the zone's goals", 'not an objective') };
      }
      if (
        objective.done ||
        objectivesDone(ctx.db, zone.id).has(objective.key) ||
        doneRulingWaits(ctx, zone.id, objective.key)
      ) {
        return { out: refused('that objective is already done', 'already done') };
      }
      const at = ctx.now();
      const briefingId = raiseBriefing(
        ctx.db,
        {
          zoneId: zone.id,
          kind: 'objective_done',
          subject: `${OBJECTIVE_PREFIX}${objective.key}`,
          decision: `Mark objective "${objective.title}" done?`,
          why: `Command asked for it in the chat (thread ${p.threadId}, message ${p.messageId}).`,
          options: [
            { id: 'done', label: 'Mark it done', effect: 'advance_objective' },
            { id: 'keep', label: 'Keep it open', effect: 'none' },
          ],
          onHold: 'All crew filing for the next objective',
          source: 'server',
          sourceRef: `chat:${p.tokenId}`,
        },
        at,
      );
      const r = ruleAction(actionCtx(ctx, p), briefingId, 'done', '', {});
      if (!r.ok) return failed(r);
      return {
        out: ok(
          `Objective ${objective.key} is ruled done (briefing ${briefingId}, ruling ${r.value.rulingId}). It applies on the next pass.`,
        ),
        summary: `Marked objective "${objective.title}" done in zone ${zone.id}. It applies on the next pass.`,
        target: `${OBJECTIVE_PREFIX}${objective.key}`,
        link: briefingLink(briefingId),
      };
    });
  },
};

// ---------------------------------------------------------------------------------------------
// The forge action tools (Task 14): a label on, or an issue closed, as the author identity through
// the outbox, with no text. Each runs outside the call's transaction (R10) and carries Undo.

const issueLink = (zone: DropZoneConfig, n: number): string =>
  `https://github.com/${zone.repo}/issues/${n}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The zone's forges, or why the chat cannot write to it. */
function forgesOf(ctx: ChatToolContext, zone: DropZoneConfig): ForgePair | Acted {
  if (!ctx.forgesFor)
    return { out: refused('this server has no forge to write through', 'no forge') };
  return ctx.forgesFor(zone.id);
}
const isActed = (f: ForgePair | Acted): f is Acted => 'out' in f;

/** Why the zone writes nothing to its forge now: observe mode. Null when it may. */
function observing(ctx: ChatToolContext, zone: DropZoneConfig): Acted | null {
  return getZoneMode(ctx.db, zone.id, zone.mode) === 'observe'
    ? {
        out: refused(
          `zone ${zone.id} is in observe mode: nothing is written to the forge`,
          'observe mode',
        ),
      }
    : null;
}

/** Reads one issue for a forge action: the issue, or why the action is refused. */
async function issueFor(forges: ForgePair, n: number): Promise<IssueFacts | Acted> {
  let issue: IssueFacts | null;
  try {
    issue = await forges.author.getIssue(n);
  } catch {
    return { out: refused(`reading issue #${n} failed`, 'forge error') };
  }
  if (issue === null) return { out: refused(`no issue #${n}`, 'unknown issue') };
  if (issue.pullRequest)
    return { out: refused(`#${n} is a pull request, not an issue`, 'not an issue') };
  return issue;
}

/** Runs one forge write through the outbox; null once it is written (or left to read-back). */
async function written(ctx: ChatToolContext, forges: ForgePair, op: Op): Promise<Acted | null> {
  try {
    const r = await runOp(ctx.db, forges, op, ctx.now());
    if (r.state === 'failed') return { out: refused('the forge write failed', 'forge error') };
    return null;
  } catch (err) {
    // The kill switch or observe mode, engaged between the checks and the write.
    const text = redact(errorText(err), redactionList(ctx.config.secrets));
    return { out: refused(text, /observe/.test(text) ? 'observe mode' : 'killed') };
  }
}

/** A queue refusal's reason code: the route's status, in the audit's fixed vocabulary. */
function queueRefusal(r: Extract<QueueResult, { ok: false }>, secrets: string[]): Acted {
  const detail =
    r.status === 404
      ? 'unknown issue'
      : r.status === 502
        ? 'forge error'
        : /observe mode/.test(r.error)
          ? 'observe mode'
          : 'not in backlog';
  return { out: refused(redact(r.error, secrets), detail) };
}

const IssueArgs = z.strictObject({ zoneId: ZoneId, issue: z.number().int().positive() });

const queueIssueTool: ChatToolDef = {
  name: 'queue_issue',
  scope: 'chat-write',
  external: true,
  description:
    '"Work on it", on the owner\'s word: puts the zone\'s ready label on one backlog issue (from ' +
    'list_open_issues), so intake picks it up on its next pass. Refused for an issue that is ' +
    "closed, already Jumpmaster's, or by an author without write access. Undo takes the label off.",
  input: IssueArgs,
  run(ctx, args: z.infer<typeof IssueArgs>) {
    const p = chatOf(ctx);
    return cardedAsync(ctx, 'queue', args, async () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const forges = forgesOf(ctx, zone);
      if (isActed(forges)) return forges;
      const r = await queueIssue(ctx.db, forges, zone, args.issue, ctx.now());
      if (!r.ok) return queueRefusal(r, redactionList(ctx.config.secrets));
      auditAction(actionCtx(ctx, p), 'zone.queue', { issue: args.issue, opKey: r.opKey }, zone.id);
      ctx.kick?.();
      return {
        out: ok(
          `Issue #${args.issue} in zone ${zone.id} now carries ${zone.readyLabel}: intake picks it up on its next pass.`,
        ),
        summary: `Put ${zone.readyLabel} on issue #${args.issue} in zone ${zone.id}: intake picks it up on its next pass.`,
        target: `issue:${args.issue}`,
        link: issueLink(zone, args.issue),
        undo: { op: 'labels', number: args.issue, label: zone.readyLabel },
      };
    });
  },
};

const ItemArgs = z.strictObject({ zoneId: ZoneId, itemId: z.number().int().positive() });

const retryParkedTool: ChatToolDef = {
  name: 'retry_parked',
  scope: 'chat-write',
  external: true,
  description:
    "Retries a parked work item (from list_work), on the owner's word: puts the zone's retry " +
    'label on its issue, as a person would; the next pass resets its attempts and puts it back on ' +
    'its track. Undo takes the label off.',
  input: ItemArgs,
  run(ctx, args: z.infer<typeof ItemArgs>) {
    const p = chatOf(ctx);
    return cardedAsync(ctx, 'retry', args, async () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const item = getWorkItem(ctx.db, args.itemId);
      if (!item || item.dropZoneId !== zone.id) {
        return { out: refused(`no work item ${args.itemId} in zone ${zone.id}`, 'unknown item') };
      }
      if (item.state !== 'parked') {
        return { out: refused(`work item ${item.id} is not parked (${item.state})`, 'not parked') };
      }
      const observe = observing(ctx, zone);
      if (observe) return observe;
      const forges = forgesOf(ctx, zone);
      if (isActed(forges)) return forges;
      const n = item.issueNumber;
      const issue = await issueFor(forges, n);
      if ('out' in issue) return issue;
      if (issue.labels.some((l) => l.toLowerCase() === zone.retryLabel.toLowerCase())) {
        return {
          out: refused(`issue #${n} already carries ${zone.retryLabel}`, 'already labeled'),
        };
      }
      const opKey = `labels:${zone.id}:retry:${item.id}:${ctx.now().getTime()}`;
      const payload: SetLabelsPayload = { number: n, add: [zone.retryLabel], remove: [] };
      const failed = await written(ctx, forges, {
        kind: 'set_labels',
        opKey,
        zoneId: zone.id,
        itemId: item.id,
        payload,
      });
      if (failed) return failed;
      auditAction(actionCtx(ctx, p), 'zone.retry', { item: item.id, issue: n, opKey }, zone.id);
      ctx.kick?.();
      return {
        out: ok(
          `Issue #${n} (work item ${item.id}) now carries ${zone.retryLabel}: the next pass retries it.`,
        ),
        summary: `Put ${zone.retryLabel} on issue #${n} in zone ${zone.id}: the next pass retries work item ${item.id}.`,
        target: `issue:${n}`,
        link: issueLink(zone, n),
        undo: { op: 'labels', number: n, label: zone.retryLabel },
      };
    });
  },
};

const closeIssueTool: ChatToolDef = {
  name: 'close_issue',
  scope: 'chat-write',
  external: true,
  description:
    "Closes an issue, on the owner's word: the state alone, with no comment and no text. Refused " +
    'while a drop works on it or its pull request is open. Undo reopens it.',
  input: IssueArgs,
  run(ctx, args: z.infer<typeof IssueArgs>) {
    const p = chatOf(ctx);
    return cardedAsync(ctx, 'close', args, async () => {
      const zone = zoneNeeded(ctx);
      if (!zone) return { out: refused('unknown zone', 'unknown zone') };
      const n = args.issue;
      const item = listWorkItems(ctx.db, zone.id).find((w) => w.issueNumber === n);
      if (item?.state === 'in_flight') {
        return { out: refused(`a drop is working on issue #${n} (in flight)`, 'in flight') };
      }
      if (item?.state === 'pr_open') {
        return { out: refused(`issue #${n} has its pull request open`, 'pr open') };
      }
      const observe = observing(ctx, zone);
      if (observe) return observe;
      const forges = forgesOf(ctx, zone);
      if (isActed(forges)) return forges;
      const issue = await issueFor(forges, n);
      if ('out' in issue) return issue;
      if (issue.state !== 'open')
        return { out: refused(`issue #${n} is already closed`, 'closed') };
      const opKey = `close:${zone.id}:${n}:${ctx.now().getTime()}`;
      const payload: UpdateIssuePayload = { number: n, state: 'closed' };
      const failed = await written(ctx, forges, {
        kind: 'update_issue',
        opKey,
        zoneId: zone.id,
        itemId: null,
        payload,
      });
      if (failed) return failed;
      auditAction(actionCtx(ctx, p), 'issue.close', { issue: n, opKey }, zone.id);
      return {
        out: ok(`Issue #${n} in zone ${zone.id} is closed.`),
        summary: `Closed issue #${n} in zone ${zone.id}.`,
        target: `issue:${n}`,
        link: issueLink(zone, n),
        undo: { op: 'reopen', number: n },
      };
    });
  },
};

export const CHAT_ACTION_TOOLS: ChatToolDef[] = [
  ruleBriefingTool,
  setZoneModeTool,
  runCrewCycleTool,
  markObjectiveDoneTool,
  queueIssueTool,
  retryParkedTool,
  closeIssueTool,
];
