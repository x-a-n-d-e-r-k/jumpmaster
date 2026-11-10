/**
 * A small line-based reader for GitHub Actions workflow files, enough to propose the required
 * checks of a branch ruleset: the job names a workflow reports, and whether it runs on pull
 * requests. Workflow text is repository content, so it is data (§7.1): nothing here evaluates it,
 * and anything it cannot read is left out rather than guessed.
 *
 * A matrix job reports one check per combination (`build (ubuntu-latest)`) and a reusable
 * workflow's jobs report as `caller / inner`; neither is expanded here, which is what
 * `MATRIX_AND_REUSABLE_NOTE` tells the operator.
 */

export const MATRIX_AND_REUSABLE_NOTE =
  "A matrix job reports one check per combination, such as build (ubuntu-latest), and a reusable workflow's jobs report as caller / inner: check the exact names on a pull request's Checks tab and correct the required checks to match.";

type Line = { indent: number; text: string };

/** Non-blank, non-comment lines, with their indentation. */
function linesOf(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const text = line.trimStart();
    if (text === '' || text.startsWith('#')) continue;
    out.push({ indent: line.length - text.length, text: text.trimEnd() });
  }
  return out;
}

/** `key: rest` with the key unquoted, or null. */
function keyOf(text: string): { key: string; rest: string } | null {
  const m = /^(?:"([^"]*)"|'([^']*)'|([^\s:#'"][^:#]*?))\s*:(?:\s+(.*)|$)/.exec(text);
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3] ?? '', rest: (m[4] ?? '').trim() };
}

/** A scalar value without its trailing comment and quotes. */
function scalar(rest: string): string {
  const v = rest.trim();
  if (v.startsWith('"')) return /^"((?:[^"\\]|\\.)*)"/.exec(v)?.[1] ?? '';
  if (v.startsWith("'")) return /^'((?:[^']|'')*)'/.exec(v)?.[1]?.replaceAll("''", "'") ?? '';
  return v.replace(/\s+#.*$/, '').trim();
}

/** The lines of a top-level key's block, and the value on its own line. */
function topBlock(lines: Line[], key: string): { rest: string; body: Line[] } | null {
  const i = lines.findIndex((l) => l.indent === 0 && keyOf(l.text)?.key === key);
  if (i < 0) return null;
  const head = keyOf(lines[i]?.text ?? '');
  const body: Line[] = [];
  for (const l of lines.slice(i + 1)) {
    if (l.indent === 0) break;
    body.push(l);
  }
  return { rest: head?.rest ?? '', body };
}

/**
 * The check names a workflow's jobs report: each key directly under the top-level `jobs:`,
 * replaced by the job's own `name:` when it has one. A name built from an expression (a matrix's)
 * leaves the job id.
 */
export function jobNames(yaml: string): string[] {
  const jobs = topBlock(linesOf(yaml), 'jobs');
  if (!jobs || jobs.body.length === 0) return [];
  const childIndent = jobs.body[0]?.indent ?? 0;
  const names: string[] = [];
  for (let i = 0; i < jobs.body.length; i++) {
    const line = jobs.body[i];
    if (!line || line.indent !== childIndent) continue;
    const job = keyOf(line.text);
    if (!job || job.key === '' || job.rest !== '') continue;
    let name = job.key;
    const propIndent = jobs.body[i + 1]?.indent;
    for (let j = i + 1; j < jobs.body.length; j++) {
      const prop = jobs.body[j];
      if (!prop || prop.indent <= childIndent) break;
      if (prop.indent !== propIndent) continue;
      const kv = keyOf(prop.text);
      if (kv?.key === 'name') {
        const v = scalar(kv.rest);
        if (v !== '' && !v.includes('${{')) name = v;
      }
    }
    names.push(name);
  }
  return names;
}

/** Whether the workflow's top-level `on:` names the `pull_request` event. */
export function runsOnPullRequest(yaml: string): boolean {
  const on = topBlock(linesOf(yaml), 'on');
  if (!on) return false;
  const events: string[] = [];
  if (on.rest !== '') {
    const v = on.rest.replace(/\s+#.*$/, '');
    for (const e of v.replace(/^\[|\]$/g, '').split(',')) events.push(scalar(e));
  }
  const childIndent = on.body[0]?.indent;
  for (const l of on.body) {
    if (l.indent !== childIndent) continue;
    if (l.text.startsWith('- ')) events.push(scalar(l.text.slice(2)));
    else {
      const kv = keyOf(l.text);
      if (kv) events.push(kv.key);
    }
  }
  return events.includes('pull_request');
}
