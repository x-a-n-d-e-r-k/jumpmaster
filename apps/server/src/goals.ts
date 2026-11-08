import { createHash } from 'node:crypto';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import type { Forge } from './forge/github.js';

/** Bump when the parse changes, so every stored GOAL.md is parsed again. */
export const PARSER_VERSION = 1;

export type Objective = { key: string; title: string; done: boolean; body: string };

export type GoalParse =
  | { ok: true; lighthouse: string; objectives: Objective[]; sections: Record<string, string> }
  | { ok: false; error: string };

export type GoalRow = {
  zoneId: string;
  sha256: string | null;
  parserVersion: number;
  raw: string | null;
  parse: GoalParse;
  readAt: string;
};

const FENCE = /^\s{0,3}(```|~~~)/;
const H2 = /^##\s+(.+?)\s*#*\s*$/;
const H3 = /^###\s+(.+?)\s*#*\s*$/;
const CHECKBOX = /^[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const DONE_SUFFIX = /\s*\(done\)$/i;
const KEY_MAX = 60;

/** A line with whether it sits inside a fenced code block (the fence lines count as inside). */
type Line = { text: string; fenced: boolean };

function scan(md: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  for (const text of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = FENCE.exec(text);
    if (fence === null && m) {
      fence = m[1] ?? null;
      out.push({ text, fenced: true });
    } else if (fence !== null) {
      out.push({ text, fenced: true });
      if (m && m[1] === fence) fence = null;
    } else {
      out.push({ text, fenced: false });
    }
  }
  return out;
}

const joinBody = (lines: Line[]): string =>
  lines
    .map((l) => l.text)
    .join('\n')
    .trim();

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_MAX)
    .replace(/-+$/, '');
  return s || 'objective';
}

/** Slugged keys, with `-2`, `-3` … on repeats, each at most `KEY_MAX` characters. */
function withKeys(items: Omit<Objective, 'key'>[]): Objective[] {
  const seen = new Map<string, number>();
  return items.map((o) => {
    const base = slug(o.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const suffix = n === 1 ? '' : `-${n}`;
    const key = `${base.slice(0, KEY_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    return { key, ...o };
  });
}

function parseObjectives(lines: Line[]): Omit<Objective, 'key'>[] {
  const hasHeadings = lines.some((l) => !l.fenced && H3.test(l.text));
  const out: Omit<Objective, 'key'>[] = [];
  let current: { title: string; done: boolean; body: Line[] } | null = null;
  const flush = () => {
    if (current)
      out.push({ title: current.title, done: current.done, body: joinBody(current.body) });
  };
  for (const l of lines) {
    const head = l.fenced ? null : hasHeadings ? H3.exec(l.text) : null;
    const box = l.fenced || hasHeadings ? null : CHECKBOX.exec(l.text);
    if (head) {
      flush();
      const raw = head[1] ?? '';
      current = { title: raw.replace(DONE_SUFFIX, ''), done: DONE_SUFFIX.test(raw), body: [] };
    } else if (box) {
      flush();
      current = { title: box[2] ?? '', done: box[1] !== ' ', body: [] };
    } else if (current) {
      // Under checkboxes only indented continuation lines belong to the item.
      if (hasHeadings || l.fenced || /^\s+\S/.test(l.text) || l.text.trim() === '') {
        current.body.push(hasHeadings ? l : { ...l, text: l.text.trim() });
      } else {
        flush();
        current = null;
      }
    }
  }
  flush();
  return out;
}

/** Parses GOAL.md with a line scanner: `## Lighthouse`, `## Objectives`, and other `##` sections. */
export function parseGoals(md: string): GoalParse {
  const sections = new Map<string, Line[]>();
  let name: string | null = null;
  for (const l of scan(md)) {
    const h = l.fenced ? null : H2.exec(l.text);
    if (h && !l.text.startsWith('###')) {
      name = (h[1] ?? '').trim();
      if (!sections.has(name)) sections.set(name, []);
      continue;
    }
    if (name !== null) sections.get(name)?.push(l);
  }
  const find = (want: string) =>
    [...sections.keys()].find((k) => k.toLowerCase() === want.toLowerCase());
  const objKey = find('Objectives');
  if (objKey === undefined) return { ok: false, error: 'no ## Objectives section' };
  const objectives = withKeys(parseObjectives(sections.get(objKey) ?? []));
  if (objectives.length === 0) {
    return { ok: false, error: '## Objectives lists no ### headings or - [ ] items' };
  }
  const lightKey = find('Lighthouse');
  const rest: Record<string, string> = {};
  for (const [k, lines] of sections) {
    if (k !== objKey && k !== lightKey) rest[k] = joinBody(lines);
  }
  return {
    ok: true,
    lighthouse: lightKey === undefined ? '' : joinBody(sections.get(lightKey) ?? []),
    objectives,
    sections: rest,
  };
}

/** The first objective not done, or null (all done, or no usable parse). */
export function currentObjective(p: GoalParse): Objective | null {
  if (!p.ok) return null;
  return p.objectives.find((o) => !o.done) ?? null;
}

type GoalDbRow = {
  zoneId: string;
  sha256: string | null;
  parserVersion: number;
  raw: string | null;
  parseJson: string;
  readAt: string;
};

export function getGoals(db: Db, zoneId: string): GoalRow | undefined {
  const r = db
    .prepare(
      `SELECT zone_id AS zoneId, sha256, parser_version AS parserVersion, raw,
         parse_json AS parseJson, read_at AS readAt FROM goals WHERE zone_id = ?`,
    )
    .get(zoneId) as GoalDbRow | undefined;
  if (!r) return undefined;
  const { parseJson, ...rest } = r;
  return { ...rest, parse: JSON.parse(parseJson) as GoalParse };
}

function putGoals(db: Db, row: GoalRow): void {
  db.prepare(
    `INSERT INTO goals (zone_id, sha256, parser_version, raw, parse_json, read_at)
     VALUES (@zoneId, @sha256, @parserVersion, @raw, @parseJson, @readAt)
     ON CONFLICT (zone_id) DO UPDATE SET sha256 = excluded.sha256,
       parser_version = excluded.parser_version, raw = excluded.raw,
       parse_json = excluded.parse_json, read_at = excluded.read_at`,
  ).run({ ...row, parseJson: JSON.stringify(row.parse) });
}

/**
 * Reads the zone's goal file at `ref` and stores its parse. The parse is redone only when the
 * file's sha256 or `PARSER_VERSION` changed. A failed read throws and leaves the stored row as it
 * was; a missing file is stored as a parse error.
 */
export async function refreshGoals(
  db: Db,
  forge: Forge,
  zone: DropZoneConfig,
  ref: string,
  now: Date,
): Promise<GoalRow> {
  const path = zone.crew.goalPath;
  const raw = await forge.getFileAt(ref, path);
  const readAt = now.toISOString();
  const base = { zoneId: zone.id, parserVersion: PARSER_VERSION, readAt };
  if (raw === null) {
    const row: GoalRow = {
      ...base,
      sha256: null,
      raw: null,
      parse: { ok: false, error: `${path} not found` },
    };
    putGoals(db, row);
    return row;
  }
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const prev = getGoals(db, zone.id);
  const row: GoalRow =
    prev && prev.sha256 === sha256 && prev.parserVersion === PARSER_VERSION
      ? { ...prev, readAt }
      : { ...base, sha256, raw, parse: parseGoals(raw) };
  putGoals(db, row);
  return row;
}
