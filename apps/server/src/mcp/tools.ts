import { CrewLeadOutputSchema, containsSecret, protectedPathMatches } from '@jumpmaster/protocol';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type BriefingSource, listBriefings, listRulings } from '../briefings.js';
import type { ChatCard } from '../chat/cards.js';
import { type Config, type DropZoneConfig, mcpConfigOf } from '../config.js';
import { type ApplyReport, applyCrewActions, type CrewActionInput } from '../crew/actions.js';
import { getCrewIssueByNumber, listCrewIssues } from '../crew/store.js';
import type { Db } from '../db/open.js';
import {
  ACTIVE_DROP_STATES,
  getPullRequest,
  getUsageState,
  getZoneMode,
  isKilled,
  listOutbox,
  listWorkItems,
} from '../db/repo.js';
import { getGoals } from '../goals.js';
import { redactionList } from '../scrub.js';
import { dispatchGate } from '../usage.js';
import { type Acted, CHAT_ACTION_TOOLS, carded } from './chat-actions.js';
import { CHAT_TOOLS } from './chat-tools.js';
import {
  type ChatToolContext,
  fencer,
  type Outcome,
  ok,
  PREAMBLE,
  refused,
  type ToolContext,
  type ToolDef,
  type Trust,
  type ZoneToolDef,
} from './kit.js';
import { auditMcp, isChatPrincipal, type McpScope, updateMcpAudit } from './tokens.js';

/**
 * What `callTool` is given: a zone principal's zone (resolved by the route), or none for a chat
 * principal, whose zone is the call's `zoneId`. `actions` says whether a chat principal may call
 * the write tools (off until the chat's actions land).
 */
export type CallContext = Omit<ToolContext, 'zone'> & { zone?: DropZoneConfig; actions?: boolean };

export type { ToolContext, ToolScope } from './kit.js';

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** An audit code for an internal error: SQLite's own code (a fixed vocabulary), else `exception`. */
const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : 'exception';
};

/** Briefing text the server built is data; text the crew or assistant wrote is untrusted. */
const briefingTrust = (source: BriefingSource): Trust =>
  source === 'server' ? 'data' : 'untrusted';
const sourceName = (source: BriefingSource): string => (source === 'mcp' ? 'assistant' : source);

// ---------------------------------------------------------------------------------------------
// Read tools

const NoArgs = z.strictObject({});

const getGoalsTool: ZoneToolDef = {
  name: 'get_goals',
  scope: 'read',
  description:
    "The zone's objective ladder from its goal file: lighthouse, objectives, the current one.",
  input: NoArgs,
  run({ db, zone }, _args, fx) {
    // Trusted only while the goal file is a protected path no drop can change (config requires it;
    // checked again here so a hand-built zone can't promote repo text to trusted).
    const trust: Trust = zone.protectedPaths.some((g) =>
      protectedPathMatches(zone.crew.goalPath, g),
    )
      ? 'trusted'
      : 'untrusted';
    const row = getGoals(db, zone.id);
    if (!row) return ok(`Zone ${zone.id}: the goal file has not been read yet.`);
    if (!row.parse.ok) return ok(`Zone ${zone.id}: the goal file does not parse.`);
    const p = row.parse;
    const current = p.objectives.find((o) => !o.done);
    return ok(
      [
        `Zone ${zone.id}. ${PREAMBLE}`,
        // Trusted: goalPath is a protected path no drop can change, though anyone who can push can.
        `Lighthouse: ${fx(trust, 'lighthouse', p.lighthouse)}`,
        'Objectives (key: title):',
        ...p.objectives.map(
          (o) => `- [${o.done ? 'x' : ' '}] ${o.key}: ${fx(trust, 'objective', o.title)}`,
        ),
        `Current objective: ${current ? current.key : 'none (all done)'}`,
      ].join('\n'),
    );
  },
};

const listWorkTool: ZoneToolDef = {
  name: 'list_work',
  scope: 'read',
  description:
    "The zone's work items (issue number, state, PR) and crew issues. Titles only; bodies come from get_work_item.",
  input: NoArgs,
  run({ db, zone }, _args, fx) {
    const lines = [`Zone ${zone.id}. ${PREAMBLE}`, '', 'Work items:'];
    for (const w of listWorkItems(db, zone.id)) {
      const pr = getPullRequest(db, w.id);
      lines.push(
        `- #${w.issueNumber} state=${w.state} pr=${pr ? `#${pr.number} ${pr.state}` : 'none'}`,
        `  title ${fx('data', 'title', w.title)}`,
      );
      if (w.reason) lines.push(`  reason ${fx('untrusted', 'reason', w.reason)}`);
    }
    lines.push('', 'Crew issues:');
    for (const c of listCrewIssues(db, zone.id)) {
      lines.push(
        `- crew issue ${c.id} number=${c.number ?? 'none'} state=${c.state} objective=${c.objective} source=${c.source === 'mcp' ? 'assistant' : 'crew'}`,
        `  title ${fx('untrusted', 'title', c.title)}`,
      );
    }
    return ok(lines.join('\n'));
  },
};

const getWorkItemTool: ZoneToolDef = {
  name: 'get_work_item',
  scope: 'read',
  description: 'One work item or crew issue in the zone, by issue number, with its body.',
  input: z.strictObject({ number: z.number().int().positive() }),
  run({ db, zone }, args: { number: number }, fx) {
    const w = listWorkItems(db, zone.id).find((i) => i.issueNumber === args.number);
    if (w) {
      const pr = getPullRequest(db, w.id);
      return ok(
        [
          `Zone ${zone.id}. ${PREAMBLE}`,
          `Work item #${w.issueNumber} state=${w.state} pr=${pr ? `#${pr.number} ${pr.state}` : 'none'}`,
          `title ${fx('data', 'title', w.title)}`,
          `body ${fx('data', 'body', w.body)}`,
          ...(w.reason ? [`reason ${fx('untrusted', 'reason', w.reason)}`] : []),
        ].join('\n'),
      );
    }
    const c = getCrewIssueByNumber(db, zone.id, args.number);
    if (c) {
      return ok(
        [
          `Zone ${zone.id}. ${PREAMBLE}`,
          `Crew issue ${c.id} #${args.number} state=${c.state} objective=${c.objective}`,
          `title ${fx('untrusted', 'title', c.title)}`,
          `body ${fx('untrusted', 'body', c.body)}`,
        ].join('\n'),
      );
    }
    return refused(`issue #${args.number} not found in this zone`, 'not found');
  },
};

const listBriefingsTool: ZoneToolDef = {
  name: 'list_briefings',
  scope: 'read',
  description: "The zone's open briefings: decisions waiting on Command.",
  input: NoArgs,
  run({ db, zone }, _args, fx) {
    const lines = [`Zone ${zone.id}. ${PREAMBLE}`, '', 'Open briefings:'];
    for (const b of listBriefings(db, { zoneId: zone.id, state: 'open' })) {
      const t = briefingTrust(b.source);
      lines.push(
        `- briefing ${b.id} kind=${b.kind} raised by ${sourceName(b.source)}`,
        `  subject ${fx(t, 'subject', b.subject)}`,
        `  decision ${fx(t, 'decision', b.decision)}`,
        `  why ${fx(t, 'why', b.why)}`,
        `  options ${fx(t, 'options', b.options.map((o) => `${o.id}: ${o.label}`).join('\n'))}`,
      );
      if (b.recommendation)
        lines.push(`  recommendation ${fx(t, 'recommendation', b.recommendation)}`);
      if (b.onHold) lines.push(`  on hold ${fx(t, 'on-hold', b.onHold)}`);
      if (b.diagnosis) lines.push(`  diagnosis ${fx('untrusted', 'diagnosis', b.diagnosis)}`);
    }
    return ok(lines.join('\n'));
  },
};

const listRulingsTool: ZoneToolDef = {
  name: 'list_rulings',
  scope: 'read',
  description: "Command's recent rulings in the zone, with their notes and whether they applied.",
  input: NoArgs,
  run({ db, zone }, _args, fx) {
    const lines = [`Zone ${zone.id}. ${PREAMBLE}`, '', 'Rulings (newest first):'];
    for (const r of listRulings(db, zone.id)) {
      lines.push(
        `- ruling ${r.id} on briefing ${r.briefingId}: chose ${r.choice} (effect ${r.effect ?? 'unknown'}) at ${r.createdAt}; ${r.appliedAt ? `applied ${r.appliedAt}` : 'not applied'}`,
      );
      if (r.note) lines.push(`  note ${fx('trusted', 'note', r.note)}`);
      if (r.applyError) lines.push(`  apply error ${fx('data', 'apply-error', r.applyError)}`);
      if (r.diagnosis) lines.push(`  diagnosis ${fx('untrusted', 'diagnosis', r.diagnosis)}`);
    }
    return ok(lines.join('\n'));
  },
};

const ACTIVE_DROPS: readonly string[] = ACTIVE_DROP_STATES;

const getQueueTool: ZoneToolDef = {
  name: 'get_queue',
  scope: 'read',
  description:
    "The zone's mode, the kill switch, the usage gate (with any credits stop), its queued and active drops, and its unresolved forge writes.",
  input: NoArgs,
  run({ db, config, zone, now }) {
    const at = now();
    const u = getUsageState(db);
    const drops = db
      .prepare(
        `SELECT id, role, state, work_item_id AS workItemId, created_at AS createdAt FROM drops
           WHERE drop_zone_id = ? AND state IN (${ACTIVE_DROPS.map(() => '?').join(', ')})
           ORDER BY created_at, id`,
      )
      .all(zone.id, ...ACTIVE_DROPS);
    return ok(
      JSON.stringify(
        {
          zone: zone.id,
          mode: getZoneMode(db, zone.id, zone.mode),
          killed: isKilled(db),
          crewEnabled: zone.crew.enabled,
          // Global, deliberately: whether anything can run at all.
          gate: dispatchGate(db, config.usage, at),
          creditsStop: {
            stoppedAt: u.overageStoppedAt,
            until: u.overageUntil,
            resumeUntil: u.overageResumeUntil,
          },
          drops,
          outbox: listOutbox(db, ['pending', 'unknown', 'failed'], zone.id).map((o) => ({
            kind: o.kind,
            state: o.state,
            createdAt: o.createdAt,
          })),
        },
        null,
        2,
      ),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// Write tools: the crew's own action core, with the crew's own schema, as source `mcp`.

const FileIssuesArgs = z.strictObject({ issues: CrewLeadOutputSchema.shape.fileIssues });
const BriefingsArgs = z.strictObject({ briefings: CrewLeadOutputSchema.shape.briefings });

/** Checks a write must pass before the action core runs; null when it may go ahead. */
function writeBlocked(
  ctx: ToolContext,
  args: unknown,
  opts: { needsCrew: boolean } = { needsCrew: true },
): Outcome | null {
  const { db, config, zone, now } = ctx;
  if (opts.needsCrew && !zone.crew.enabled)
    return refused("the zone's crew is not enabled", 'crew disabled');
  const at = now();
  if (dispatchGate(db, config.usage, at) === 'stopped') {
    const until = getUsageState(db).overageUntil;
    return refused(
      `a usage credits stop is in force${until ? ` until ${until}` : ''}; writes wait for it to lift`,
      'usage stopped',
    );
  }
  if (containsSecret(JSON.stringify(args), redactionList(config.secrets))) {
    return refused('the arguments contain a token or secret', 'contains secret');
  }
  return null;
}

function applied(ctx: ToolContext, input: CrewActionInput): { out: Outcome; report: ApplyReport } {
  const r = applyCrewActions(
    ctx.db,
    ctx.zone,
    input,
    { kind: 'mcp', tokenId: ctx.principal.tokenId },
    ctx.now(),
  );
  const any = r.filed.length + r.briefings.length > 0;
  const text = JSON.stringify(
    { filedCrewIssues: r.filed, briefings: r.briefings, refused: r.refused },
    null,
    2,
  );
  return {
    out: {
      result: { content: [{ type: 'text', text }], ...(any ? {} : { isError: true }) },
      outcome: any ? 'ok' : 'refused',
      // Counts only: refusal reasons can echo the caller's keys and objectives.
      detail: `filed ${r.filed.length}, briefings ${r.briefings.length}, refused ${r.refused.length}`,
    },
    report: r,
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const refusedTail = (r: ApplyReport): string =>
  r.refused.length > 0 ? ` ${plural(r.refused.length, 'other was', 'others were')} refused.` : '';

/** A filing's card: counts and the server's crew issue ids, never the titles the caller wrote. */
function filedCard(ctx: ToolContext, input: CrewActionInput): Acted {
  const { out, report: r } = applied(ctx, input);
  return {
    out,
    summary:
      `Filed ${plural(r.filed.length, 'staged issue', 'staged issues')} in zone ${ctx.zone.id} ` +
      `(crew issue ${r.filed.join(', ')}). Nothing starts until Command promotes ` +
      `${r.filed.length === 1 ? 'it' : 'them'}.${refusedTail(r)}`,
    target: `zone:${ctx.zone.id}`,
    link: `/zones/${encodeURIComponent(ctx.zone.id)}`,
  };
}

/** A briefing's card: how many the server raised, linked to the first. */
function briefedCard(ctx: ToolContext, input: CrewActionInput): Acted {
  const { out, report: r } = applied(ctx, input);
  const first = r.briefings[0];
  return {
    out,
    summary: `Raised ${plural(r.briefings.length, 'briefing', 'briefings')} for Command in zone ${ctx.zone.id}.${refusedTail(r)}`,
    ...(first === undefined ? {} : { target: `briefing:${first}`, link: `/briefings/${first}` }),
  };
}

const fileStagedIssuesTool: ZoneToolDef = {
  name: 'file_staged_issues',
  scope: 'write',
  description:
    'Proposes up to 5 issues for the current objectives. Each is filed on the forge under the staged ' +
    'label by Jumpmaster and waits for Command to promote it; the same validation, slots and ' +
    'duplicate checks as crew drops apply. Bodies need "## Acceptance criteria" (a checklist) and ' +
    '"## Tests" sections. Works with the crew off. Nothing starts until Command rules: the ' +
    'server (or, with the crew on, the crew after judging it) puts a Promote briefing to ' +
    'Command, whose ruling promotes it.',
  input: FileIssuesArgs,
  run(ctx, args: z.infer<typeof FileIssuesArgs>) {
    // Staged issues start nothing until Command promotes them, so filing needs no crew.
    return carded(ctx, 'file_issues', args, () => {
      const blocked = writeBlocked(ctx, args, { needsCrew: false });
      return blocked ? { out: blocked } : filedCard(ctx, { fileIssues: args.issues });
    });
  },
};

const raiseBriefingTool: ZoneToolDef = {
  name: 'raise_briefing',
  scope: 'write',
  description:
    'Puts up to 3 decisions to Command, each with 2 to 4 options (all without effect). An upsert: ' +
    "a briefing on the same subject as an open one of the assistant's replaces its text. Shown to " +
    'Command as raised by the assistant.',
  input: BriefingsArgs,
  run(ctx, args: z.infer<typeof BriefingsArgs>) {
    return carded(ctx, 'briefing', args, () => raiseBriefings(ctx, args));
  },
};

/** Raises the assistant's briefings, within the zone's cap of open ones. */
function raiseBriefings(ctx: ToolContext, args: z.infer<typeof BriefingsArgs>): Acted {
  const blocked = writeBlocked(ctx, args);
  if (blocked) return { out: blocked };
  const { db, config, zone } = ctx;
  const cap = mcpConfigOf(config).maxOpenBriefings;
  const open = new Set(
    listBriefings(db, { zoneId: zone.id, state: 'open' })
      .filter((b) => b.source === 'mcp')
      .map((b) => b.subject),
  );
  const fresh = new Set(args.briefings.map((b) => `mcp:${b.subject}`).filter((s) => !open.has(s)));
  if (open.size + fresh.size > cap) {
    return {
      out: refused(
        `the zone holds ${open.size} open assistant briefings and the cap is ${cap}; Command rules on them first`,
        'briefing cap',
      ),
    };
  }
  return briefedCard(ctx, { briefings: args.briefings });
}

const TOOLS: ToolDef[] = [
  getGoalsTool,
  listWorkTool,
  getWorkItemTool,
  listBriefingsTool,
  listRulingsTool,
  getQueueTool,
  fileStagedIssuesTool,
  raiseBriefingTool,
  ...CHAT_TOOLS,
  ...CHAT_ACTION_TOOLS,
];
const isZoneTool = (t: ToolDef): t is ZoneToolDef => t.scope === 'read' || t.scope === 'write';
const isWriteTool = (t: ToolDef): boolean => t.scope === 'write' || t.scope === 'chat-write';
const WRITE_TOOLS = TOOLS.filter(isWriteTool).map((t) => t.name);
/** Every tool's name, as a client sees it after `mcp__jumpmaster__` (the intake skills name them). */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json as Tool['inputSchema'];
}

/**
 * Whether a scope may call a tool: a read token only the read tools, a write token every zone tool,
 * and a chat token the read tools of both kinds, plus the write tools of both with `actions`.
 */
function allowed(t: ToolDef, scope: McpScope, actions: boolean): boolean {
  if (scope === 'read') return t.scope === 'read';
  if (scope === 'write') return isZoneTool(t);
  return actions || !isWriteTool(t);
}

/** The schema a chat principal sees for a zone tool: its own, with a required `zoneId`. */
function chatInputSchema(t: ToolDef): Tool['inputSchema'] {
  const own = inputSchema(t.input);
  return {
    ...own,
    properties: { ...own.properties, zoneId: { type: 'string' } },
    required: [...(own.required ?? []), 'zoneId'],
  };
}

/**
 * The tools a token's scope may see: a read token never sees the write tools. A chat token sees
 * every zone tool it may call with a required `zoneId` added, plus the chat's own tools.
 */
export function listTools(scope: McpScope, o: { actions?: boolean } = {}): Tool[] {
  return TOOLS.filter((t) => allowed(t, scope, o.actions ?? false)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: scope === 'chat' && isZoneTool(t) ? chatInputSchema(t) : inputSchema(t.input),
  }));
}

/**
 * The zone a call acts on, and the arguments the tool parses: a zone principal's own zone, or for
 * a chat principal the configured zone its `zoneId` names (taken off the arguments of a zone tool,
 * whose schema does not know it). A chat tool keeps its arguments, and has no zone when it names
 * none. Null when a zone is needed or named and is not configured.
 */
function zoneOf(
  ctx: CallContext,
  tool: ToolDef,
  args: Record<string, unknown>,
): { zone?: DropZoneConfig; args: Record<string, unknown> } | null {
  const { principal, config } = ctx;
  if (!isChatPrincipal(principal)) {
    const zone = ctx.zone ?? config.dropZones.find((z) => z.id === principal.zoneId);
    return zone ? { zone, args } : null;
  }
  const { zoneId, ...rest } = args;
  if (!isZoneTool(tool) && zoneId === undefined) return { args };
  const zone =
    typeof zoneId === 'string' ? config.dropZones.find((z) => z.id === zoneId) : undefined;
  if (!zone) return null;
  return { zone, args: isZoneTool(tool) ? rest : args };
}

const hourBefore = (at: Date): string => new Date(at.getTime() - 60 * 60 * 1000).toISOString();

/** Rows refused by a budget are not calls the budget counts. */
const NOT_BUDGET_REFUSAL =
  "NOT (outcome = 'refused' AND detail IN ('write budget', 'call budget'))";

/**
 * Write calls the token made in the trailing hour, refused ones included (so a loop of bad calls
 * is bounded too), except refusals by a budget itself.
 */
function writesInLastHour(db: Db, tokenId: number, at: Date): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mcp_audit WHERE token_id = ? AND at > ?
         AND tool IN (${WRITE_TOOLS.map(() => '?').join(', ')}) AND ${NOT_BUDGET_REFUSAL}`,
    )
    .get(tokenId, hourBefore(at), ...WRITE_TOOLS) as { n: number };
  return n;
}

/**
 * Whether the token has spent its hourly budget of tool calls of any kind (batches included). Read
 * from the `(token_id, at)` index, so it costs at most the budget's rows.
 */
export function callBudgetSpent(db: Db, config: Config, tokenId: number, at: Date): boolean {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mcp_audit WHERE token_id = ? AND at > ?
         AND tool NOT IN ('auth', 'mint', 'revoke') AND ${NOT_BUDGET_REFUSAL}`,
    )
    .get(tokenId, hourBefore(at)) as { n: number };
  return n >= mcpConfigOf(config).callsPerHour;
}

/** Whether a call-budget refusal is already recorded in the window: it is audited once. */
const budgetRefusalRecorded = (db: Db, tokenId: number, at: Date): boolean =>
  db
    .prepare(
      `SELECT 1 FROM mcp_audit WHERE token_id = ? AND at > ? AND outcome = 'refused'
         AND detail = 'call budget' LIMIT 1`,
    )
    .get(tokenId, hourBefore(at)) !== undefined;

/** A call checked and ready to run: its tool, context and parsed arguments. */
type Ready = { ready: true; tool: ToolDef; ctx: ChatToolContext; args: unknown };

const isReady = (r: CallToolResult | Ready): r is Ready => (r as Ready).ready === true;

/** Runs a checked tool with the response's fence: a zone tool always has its zone. */
function run(r: Ready, fx: ReturnType<typeof fencer>): Outcome | Promise<Outcome> {
  const { tool, ctx, args } = r;
  if (isZoneTool(tool)) {
    if (!ctx.zone) return refused('unknown zone', 'unknown zone');
    return tool.run({ ...ctx, zone: ctx.zone }, args as never, fx);
  }
  return tool.run(ctx, args as never, fx);
}

/**
 * Runs one tool call for the principal and audits it in the handler (a hijacked reply has no
 * hooks): tool name, args hash, outcome and a reason code. Budgets, the run and the audit commit in
 * one transaction. An external tool (ruling R10) runs outside it: its budgets and arguments are
 * checked, and its audit row inserted as `ok`, in one transaction (so calls in parallel count
 * against the budget before any of them awaits the forge); the row is then set to the outcome.
 * Anything that throws, the database included, is audited `error` where the database still allows
 * it and answered with a bare JSON-RPC internal error: no error text reaches the caller.
 */
export async function callTool(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { db, principal } = ctx;
  const at = ctx.now();
  const tool = TOOLS.find((t) => t.name === name);
  // A chat call's zone is known once its `zoneId` is checked; until then the audit names none
  // (the argument is the caller's text).
  let zoneId: string | null = isChatPrincipal(principal) ? null : principal.zoneId;
  /** The external call's reserved audit row, once inserted. */
  let reserved: number | undefined;
  const audit = (outcome: 'ok' | 'refused' | 'error', detail?: string): number => {
    if (reserved !== undefined) {
      updateMcpAudit(db, reserved, outcome, detail);
      return reserved;
    }
    return auditMcp(
      db,
      {
        tokenId: principal.tokenId,
        zoneId,
        // An unknown name is the caller's text: it is not stored.
        tool: tool?.name ?? 'unknown',
        args,
        outcome,
        ...(detail ? { detail } : {}),
      },
      at,
    );
  };
  const refuse = (o: Outcome): CallToolResult => {
    audit('refused', o.detail);
    return o.result;
  };
  const finish = (t: ToolDef, out: Outcome): CallToolResult => {
    if (!isWriteTool(t) && out.outcome === 'ok') audit('ok');
    else audit(out.outcome, out.detail);
    return out.result;
  };
  const fx = fencer(redactionList(ctx.config.secrets));
  /** The call's cards, pushed to the thread's stream only once what recorded them committed. */
  const cards: ChatCard[] = [];
  const flush = (): void => {
    for (const c of cards.splice(0)) {
      try {
        ctx.onCard?.(c);
      } catch (e) {
        ctx.log?.(`mcp card push failed: ${errorMessage(e)}`);
      }
    }
  };
  try {
    const checked = db.transaction((): CallToolResult | Ready => {
      if (callBudgetSpent(db, ctx.config, principal.tokenId, at)) {
        const out = refused(
          `the call budget of ${mcpConfigOf(ctx.config).callsPerHour} tool calls an hour is spent`,
          'call budget',
        );
        return budgetRefusalRecorded(db, principal.tokenId, at) ? out.result : refuse(out);
      }
      if (!tool) return refuse(refused('unknown tool', 'unknown tool'));
      if (!allowed(tool, principal.scope, ctx.actions ?? false)) {
        return principal.scope === 'chat'
          ? refuse(refused('this chat cannot call write tools', 'chat scope'))
          : refuse(refused('a read token cannot call write tools', 'read scope'));
      }
      const target = zoneOf(ctx, tool, args);
      if (!target) return refuse(refused('unknown zone', 'unknown zone'));
      zoneId = target.zone?.id ?? null;
      if (isWriteTool(tool)) {
        const budget = mcpConfigOf(ctx.config).writesPerHour;
        if (writesInLastHour(db, principal.tokenId, at) >= budget) {
          return refuse(
            refused(`the write budget of ${budget} calls an hour is spent`, 'write budget'),
          );
        }
      }
      const parsed = tool.input.safeParse(target.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
          .join('; ');
        return refuse(refused(`invalid arguments: ${issues}`, 'invalid arguments'));
      }
      const { zone: _own, actions: _actions, onCard: _onCard, ...base } = ctx;
      const ready: Ready = {
        ready: true,
        tool,
        ctx: {
          ...base,
          ...(target.zone ? { zone: target.zone } : {}),
          now: () => at,
          onCard: (c) => cards.push(c),
        },
        args: parsed.data,
      };
      if (tool.external) {
        // Counted now: the budget sees this call while it awaits the forge.
        reserved = audit('ok');
        return ready;
      }
      const out = run(ready, fx);
      if (out instanceof Promise) throw new Error(`tool ${tool.name} is async but not external`);
      return finish(tool, out);
    })();
    if (!isReady(checked)) {
      flush();
      return checked;
    }
    const out = await run(checked, fx);
    const answered = db.transaction(() => finish(checked.tool, out))();
    flush();
    return answered;
  } catch (e) {
    cards.length = 0;
    // The transaction rolled back: whatever the tool recorded is gone with it.
    ctx.log?.(`mcp ${tool?.name ?? 'unknown tool'} failed: ${errorMessage(e)}`);
    try {
      audit('error', errorCode(e));
    } catch {
      // The database refuses even this; the caller still gets a well-formed error.
    }
    throw new McpError(ErrorCode.InternalError, 'internal error');
  }
}
