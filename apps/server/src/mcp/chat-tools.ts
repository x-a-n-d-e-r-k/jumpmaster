import { redact } from '@jumpmaster/protocol';
import { z } from 'zod';
import { jmLabelNames } from '../backlog.js';
import { type FlagRow, flagRows } from '../config/catalog.js';
import type { DropZoneConfig } from '../config.js';
import { ACTIVE_DROP_STATES, effectiveSlots, listSticks, stickCeiling } from '../db/repo.js';
import { latestDoctorRun } from '../doctor/run.js';
import type { Forge } from '../forge/github.js';
import { isJmIssueBody } from '../outbox.js';
import { redactionList } from '../scrub.js';
import { exportDropJsonl } from '../transcripts.js';
import {
  type ChatToolContext,
  type ChatToolDef,
  type Outcome,
  ok,
  PREAMBLE,
  refused,
} from './kit.js';

/**
 * The chat's install-wide read tools (crew chat, Task 9): sticks, settings with the catalog's
 * plain words, the doctor's last run, a zone's open issues and pull requests (those without a
 * Jumpmaster label included), and a drop's transcript. Every forge- or agent-written field leaves
 * inside the response's fence. The forge tools are `external`: they run outside the call's
 * transaction (ruling R10).
 */

const NoArgs = z.strictObject({});
const ZoneArg = z.string().min(1);

/** The most issues or pull requests one answer lists, and the most of a body it carries. */
const MAX_LISTED = 100;
const MAX_BODY_CHARS = 4000;
/** A transcript's tail: the default and the most lines; a longer line is cut. */
const DEFAULT_TAIL = 200;
export const MAX_TAIL = 400;
const MAX_LINE_CHARS = 2000;

const FORGE_UNAVAILABLE = (): Outcome => refused('forge unavailable', 'forge unavailable');

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]` : text;

/** The zone a tool needs: callTool has checked any `zoneId` the call named. */
function zoneNeeded(ctx: ChatToolContext): DropZoneConfig | Outcome {
  return ctx.zone ?? refused('unknown zone', 'unknown zone');
}
const isOutcome = (z: DropZoneConfig | Outcome): z is Outcome => 'outcome' in z;

/**
 * Reads the zone's author forge. Any failure, no forge included, answers `forge unavailable`:
 * the forge's error text never reaches the model.
 */
async function withForge(
  ctx: ChatToolContext,
  zone: DropZoneConfig,
  read: (forge: Forge) => Promise<Outcome>,
): Promise<Outcome> {
  let forge: Forge;
  try {
    const pair = ctx.forgesFor?.(zone.id);
    if (!pair) return FORGE_UNAVAILABLE();
    forge = pair.author;
  } catch {
    return FORGE_UNAVAILABLE();
  }
  return read(forge).catch(() => FORGE_UNAVAILABLE());
}

// ---------------------------------------------------------------------------------------------

const ACTIVE: readonly string[] = ACTIVE_DROP_STATES;

const listSticksTool: ChatToolDef = {
  name: 'list_sticks',
  scope: 'chat-read',
  description:
    'Every enrolled stick (the machines that run troopers): when it was last seen, its version, how many troopers it runs and may run, and its active drops.',
  input: NoArgs,
  run({ db }, _args, fx) {
    const active = db.prepare(
      `SELECT COUNT(*) AS n FROM drops WHERE stick_id = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`,
    );
    const sticks = listSticks(db);
    const lines = [PREAMBLE, '', `Sticks (${sticks.length}):`];
    for (const s of sticks) {
      const { n } = active.get(s.id, ...ACTIVE) as { n: number };
      lines.push(
        `- stick ${s.id} slots=${effectiveSlots(s)} ceiling=${stickCeiling(s)} activeDrops=${n} lastSeen=${s.lastSeenAt ?? 'never'} version=${s.version ?? 'unknown'} docker=${s.dockerVersion ?? 'unknown'} freeBytes=${s.freeBytes ?? 'unmeasured'} imagePolicy=${s.imagePolicy}`,
        // The stick names itself when it enrolls.
        `  name ${fx('data', 'name', s.name)}`,
      );
    }
    return ok(lines.join('\n'));
  },
};

type SettingRow = {
  path: string;
  label: string;
  help: string;
  value: unknown;
  explicit: boolean;
  guard: FlagRow['guard'];
};

/**
 * The install document and the zone's own: the store's as stored, or for a fixed config (tests,
 * tools) the config itself without its secrets and the resolved zone (its zones are resolved, so
 * the install's rows read it without them).
 */
function documentsOf(ctx: ChatToolContext): {
  install: Record<string, unknown>;
  zone?: Record<string, unknown>;
} {
  const id = ctx.zone?.id;
  if (ctx.document) {
    const install = ctx.document();
    const zones = (Array.isArray(install.dropZones) ? install.dropZones : []) as Record<
      string,
      unknown
    >[];
    const zone = id === undefined ? undefined : zones.find((z) => z.id === id);
    return { install, ...(zone ? { zone } : {}) };
  }
  const { secrets: _secrets, ...rest } = ctx.config;
  const install = { ...rest, dropZones: [] } as Record<string, unknown>;
  return { install, ...(ctx.zone ? { zone: { ...ctx.zone } } : {}) };
}

const getSettingsTool: ChatToolDef = {
  name: 'get_settings',
  scope: 'chat-read',
  description:
    "Every setting of a zone (with zoneId) or of the install (without), in the settings page's plain words: path, label, help, the value it runs with, whether it is set explicitly, and its guard (free; guarded, which asks the owner to confirm; browser-forbidden, changed only with `jumpmaster ctl` or the config file; refused).",
  input: z.strictObject({ zoneId: ZoneArg.optional() }),
  run(ctx) {
    const docs = documentsOf(ctx);
    let rows: FlagRow[];
    if (ctx.zone) {
      if (!docs.zone) return refused('unknown zone', 'unknown zone');
      rows = flagRows('zone', docs.zone, docs.install);
    } else {
      rows = flagRows('install', docs.install, docs.install);
    }
    const out: SettingRow[] = rows.map((r) => ({
      path: r.entry.path,
      label: r.entry.label,
      help: r.entry.elsewhere ? `${r.entry.help} ${r.entry.elsewhere}` : r.entry.help,
      value: r.value,
      explicit: r.explicit,
      guard: r.guard,
    }));
    const text = JSON.stringify(
      { scope: ctx.zone ? 'zone' : 'install', zone: ctx.zone?.id ?? null, rows: out },
      null,
      2,
    );
    // No setting is a secret; redacted all the same, so none can ever leave in one.
    return ok(redact(text, redactionList(ctx.config.secrets)));
  },
};

const getDoctorRunTool: ChatToolDef = {
  name: 'get_doctor_run',
  scope: 'chat-read',
  description:
    "The doctor's last finished run: each check's id, zone, status (pass, warn, fail, skip, info), summary and fix.",
  input: NoArgs,
  run({ db }, _args, fx) {
    const run = latestDoctorRun(db);
    if (!run) return ok('The doctor has not finished a run yet.');
    const lines = [
      PREAMBLE,
      '',
      `Doctor run ${run.id}, started ${run.startedAt}, finished ${run.finishedAt}:`,
    ];
    for (const c of run.checks) {
      // Summaries quote what the forge and the sticks answered: data.
      lines.push(
        `- ${c.id} zone=${c.zoneId ?? 'install'} status=${c.status}`,
        `  summary ${fx('data', 'summary', c.summary)}`,
      );
      if (c.fix) lines.push(`  fix ${fx('data', 'fix', c.fix)}`);
    }
    return ok(lines.join('\n'));
  },
};

/** GitHub compares label names without case. */
const jmLabelsOf = (labels: string[], zone: DropZoneConfig): string[] => {
  const ours = new Set(jmLabelNames(zone).map((l) => l.toLowerCase()));
  return labels.filter((l) => ours.has(l.toLowerCase()));
};

const listOpenIssuesTool: ChatToolDef = {
  name: 'list_open_issues',
  scope: 'chat-read',
  external: true,
  description:
    "A zone's open issues on the forge (pull requests aside), those without a Jumpmaster label included, optionally only those carrying `label`. Each says whether it is Jumpmaster's (one of its labels, or filed by it). At most 100.",
  input: z.strictObject({ zoneId: ZoneArg, label: z.string().min(1).max(100).optional() }),
  run(ctx, args: { label?: string }, fx) {
    const zone = zoneNeeded(ctx);
    if (isOutcome(zone)) return zone;
    return withForge(ctx, zone, async (forge) => {
      const issues = await forge.listOpenIssues(args.label);
      const lines = [`Zone ${zone.id}. ${PREAMBLE}`, '', `Open issues (${issues.length}):`];
      for (const i of issues.slice(0, MAX_LISTED)) {
        const jm = jmLabelsOf(i.labels, zone).length > 0 || isJmIssueBody(i.body);
        lines.push(
          `- #${i.number} jumpmaster=${jm ? 'yes' : 'no'} author=${i.author} opened=${i.createdAt}`,
          `  labels ${fx('untrusted', 'labels', i.labels.join(', '))}`,
          `  title ${fx('untrusted', 'title', i.title)}`,
          `  body ${fx('untrusted', 'body', cut(i.body, MAX_BODY_CHARS))}`,
        );
      }
      if (issues.length > MAX_LISTED) lines.push(`(${issues.length - MAX_LISTED} more not listed)`);
      return ok(lines.join('\n'));
    });
  },
};

const listOpenPullsTool: ChatToolDef = {
  name: 'list_open_pulls',
  scope: 'chat-read',
  external: true,
  description:
    "A zone's open pull requests from branches of its own repository (pull requests from forks are not listed): number, branch, author, labels, title and body. At most 100.",
  input: z.strictObject({ zoneId: ZoneArg }),
  run(ctx, _args, fx) {
    const zone = zoneNeeded(ctx);
    if (isOutcome(zone)) return zone;
    return withForge(ctx, zone, async (forge) => {
      const pulls = await forge.listOpenAgentPulls('');
      const lines = [`Zone ${zone.id}. ${PREAMBLE}`, '', `Open pull requests (${pulls.length}):`];
      for (const p of pulls.slice(0, MAX_LISTED)) {
        lines.push(
          `- #${p.number} head=${p.headRef} base=${p.baseRef} sha=${p.headSha ?? 'unknown'} author=${p.author}`,
          `  labels ${fx('untrusted', 'labels', p.labels.join(', '))}`,
          `  title ${fx('untrusted', 'title', p.title)}`,
          `  body ${fx('untrusted', 'body', cut(p.body, MAX_BODY_CHARS))}`,
        );
      }
      if (pulls.length > MAX_LISTED) lines.push(`(${pulls.length - MAX_LISTED} more not listed)`);
      return ok(lines.join('\n'));
    });
  },
};

const getDropTranscriptTool: ChatToolDef = {
  name: 'get_drop_transcript',
  scope: 'chat-read',
  description: `The last lines of a drop's stored transcript (JSONL: a header, then its events), for a drop of the zone. tailLines defaults to ${DEFAULT_TAIL}, at most ${MAX_TAIL}.`,
  input: z.strictObject({
    zoneId: ZoneArg,
    dropId: z.string().min(1).max(200),
    tailLines: z.number().int().min(1).max(MAX_TAIL).optional(),
  }),
  run(ctx, args: { dropId: string; tailLines?: number }, fx) {
    const zone = zoneNeeded(ctx);
    if (isOutcome(zone)) return zone;
    const owner = ctx.db
      .prepare('SELECT drop_zone_id AS zoneId FROM drops WHERE id = ?')
      .get(args.dropId) as { zoneId: string } | undefined;
    // Another zone's drop answers as one that does not exist.
    if (owner?.zoneId !== zone.id) return refused('drop not found in this zone', 'not found');
    const max = args.tailLines ?? DEFAULT_TAIL;
    let header: string | undefined;
    const tail: string[] = [];
    let total = 0;
    for (const line of exportDropJsonl(ctx.db, args.dropId)) {
      if (header === undefined) {
        header = line;
        continue;
      }
      total++;
      tail.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [cut]` : line);
      if (tail.length > max) tail.shift();
    }
    return ok(
      [
        `Zone ${zone.id}. ${PREAMBLE}`,
        `Drop ${args.dropId}: ${total} events, the last ${tail.length} shown.`,
        `header ${fx('data', 'header', header ?? '')}`,
        // What the trooper and its agent wrote: untrusted.
        `events ${fx('untrusted', 'transcript', tail.join('\n'))}`,
      ].join('\n'),
    );
  },
};

export const CHAT_TOOLS: readonly ChatToolDef[] = [
  listSticksTool,
  getSettingsTool,
  getDoctorRunTool,
  listOpenIssuesTool,
  listOpenPullsTool,
  getDropTranscriptTool,
];
