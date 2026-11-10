import type { DropZoneConfig } from '../config.js';

/**
 * The zone page's forms, as pure functions: `zoneToForm` draws a zone's fields, `formToZone` turns
 * the fields a section posts back into an RFC 7396 merge patch for that zone (only the keys the
 * section carries; a blank optional block is `null`, its removal). The page script runs these same
 * functions in the browser (`FORM_SCRIPT` is their source), so what the tests prove is what runs.
 * Text the schema would refuse (bad JSON, a word where a number goes) is passed through as typed,
 * so the schema's issue names the field.
 *
 * Every function here is self-contained: no import or module-level helper is reachable from it.
 */

type Fields = Record<string, string | string[]>;

/** The boolean fields, each a checkbox whose name a form lists in `bool`. */
export const BOOLEAN_FIELDS = [
  'ciRequired',
  'requireBranchProtection',
  'authorMayBeAdmin',
  'reviewReadToken',
] as const;

export function zoneToForm(zone: DropZoneConfig): Fields {
  const z = zone as unknown as Record<string, unknown>;
  const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(String).join('\n') : '');
  const gates = (Array.isArray(z.gates) ? z.gates : []) as {
    name: string;
    run: string;
    timeoutMinutes?: number;
  }[];
  const egress = (z.egress ?? {}) as { mode?: string; allow?: string[] };
  const out: Fields = {
    id: String(z.id),
    readyLabel: typeof z.readyLabel === 'string' ? z.readyLabel : '',
    retryLabel: typeof z.retryLabel === 'string' ? z.retryLabel : '',
    adoptPulls: Array.isArray(z.adoptPulls) ? z.adoptPulls.join(', ') : '',
    preset: typeof z.preset === 'string' ? z.preset : '',
    'gate.name': gates.map((g) => g.name),
    'gate.run': gates.map((g) => g.run),
    'gate.timeout': gates.map((g) =>
      g.timeoutMinutes === undefined ? '' : String(g.timeoutMinutes),
    ),
    verification: json(z.verification),
    services: json(z.services),
    limits: json(z.limits),
    'egress.mode': egress.mode ?? 'off',
    'egress.allow': lines(egress.allow),
    identity: typeof z.identity === 'string' ? z.identity : 'two-bot',
    ciDeadlineMinutes: z.ciDeadlineMinutes === undefined ? '' : String(z.ciDeadlineMinutes),
    protectedPaths: lines(z.protectedPaths),
    overrideApprovers: lines(z.overrideApprovers),
    bool: ['ciRequired', 'requireBranchProtection', 'authorMayBeAdmin', 'reviewReadToken'],
  };
  for (const b of ['ciRequired', 'requireBranchProtection', 'authorMayBeAdmin', 'reviewReadToken'])
    if (z[b] === true) out[b] = '1';
  return out;
}

export function formToZone(fields: Fields): unknown {
  const one = (k: string): string | undefined => {
    const v = fields[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const many = (k: string): string[] => {
    const v = fields[k];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  const has = (k: string) => Object.hasOwn(fields, k);
  const list = (text: string) =>
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  const num = (s: string): number | string => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);
  const json = (s: string): unknown => {
    if (s.trim() === '') return null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  const out: Record<string, unknown> = { id: one('id') ?? '' };
  for (const k of ['readyLabel', 'retryLabel']) if (has(k)) out[k] = (one(k) ?? '').trim();
  if (has('adoptPulls')) out.adoptPulls = list(one('adoptPulls') ?? '').map(num);
  if (has('preset')) out.preset = (one('preset') ?? '') === '' ? null : one('preset');
  if (has('gate.name')) {
    const names = many('gate.name');
    const runs = many('gate.run');
    const timeouts = many('gate.timeout');
    const gates: Record<string, unknown>[] = [];
    names.forEach((name, i) => {
      const run = (runs[i] ?? '').trim();
      const n = name.trim();
      if (n === '' && run === '') return;
      const g: Record<string, unknown> = { name: n, run };
      const t = (timeouts[i] ?? '').trim();
      if (t !== '') g.timeoutMinutes = num(t);
      gates.push(g);
    });
    out.gates = gates;
  }
  for (const k of ['verification', 'services', 'limits']) if (has(k)) out[k] = json(one(k) ?? '');
  if (has('egress.mode')) {
    const mode = one('egress.mode') ?? 'off';
    const allow = list(one('egress.allow') ?? '');
    out.egress = mode === 'off' && allow.length === 0 ? null : { mode, allow };
  }
  if (has('identity')) out.identity = one('identity');
  if (has('ciDeadlineMinutes')) {
    const v = (one('ciDeadlineMinutes') ?? '').trim();
    out.ciDeadlineMinutes = v === '' ? null : num(v);
  }
  for (const k of ['protectedPaths', 'overrideApprovers']) if (has(k)) out[k] = list(one(k) ?? '');
  for (const b of many('bool')) out[b] = one(b) === '1';
  return out;
}

/**
 * The field a schema issue belongs to, for this zone (its index in the document), or undefined
 * when the issue is another zone's or the install's. A path the forms do not carry belongs to the
 * Advanced editor.
 */
export function issueField(path: string, zoneIndex: number): string | undefined {
  const prefix = `dropZones.${zoneIndex}.`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length).split('.');
  const head = rest[0] ?? '';
  if (head === 'egress') return rest[1] === 'allow' ? 'egress.allow' : 'egress.mode';
  const fields = [
    'readyLabel',
    'retryLabel',
    'adoptPulls',
    'preset',
    'image',
    'gates',
    'verification',
    'services',
    'limits',
    'identity',
    'ciRequired',
    'ciDeadlineMinutes',
    'requireBranchProtection',
    'authorMayBeAdmin',
    'protectedPaths',
    'overrideApprovers',
    'reviewReadToken',
  ];
  return fields.includes(head) ? head : 'advanced';
}

/**
 * The RFC 7396 merge patch that turns `before` into `after`: changed values, `null` for a removed
 * key at any depth, arrays whole. The Advanced editor sends it, so a deleted key is deleted.
 */
export function toMergePatch(before: unknown, after: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(before) || !isObj(after)) return after;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) out[k] = null;
  for (const [k, v] of Object.entries(after)) {
    const was = before[k];
    if (isObj(was) && isObj(v)) {
      const inner = toMergePatch(was, v) as Record<string, unknown>;
      if (Object.keys(inner).length > 0) out[k] = inner;
    } else if (JSON.stringify(was) !== JSON.stringify(v)) out[k] = v;
  }
  if (Object.hasOwn(after, 'id')) out.id = after.id;
  return out;
}

/** The functions above, for the page's `<script>` (a shim for the names a test build injects). */
export const FORM_SCRIPT = `var __name = function (f) { return f; };\n${zoneToForm.toString()}\n${formToZone.toString()}\n${issueField.toString()}\n${toMergePatch.toString()}\n`;
