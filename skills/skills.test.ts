import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { validateIssueSpec } from '../apps/server/src/crew/actions.js';
import { currentObjective, parseGoals } from '../apps/server/src/goals.js';
import { ISSUE_SPEC_HEADINGS, renderIssueSpec } from '../apps/server/src/intake.js';
import { TOOL_NAMES } from '../apps/server/src/mcp/tools.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SKILLS = [
  'jumpmaster-intake-existing',
  'jumpmaster-intake-idea',
  'jumpmaster-intake-partial',
];
const SHARED = ['interviewer', 'scout', 'ladder-writer', 'issue-splitter'];

/** Every markdown file under skills/. */
function markdownFiles(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}
const read = (path: string): string => readFileSync(path, 'utf8');
const label = (path: string): string => relative(ROOT, path);

/** `---` frontmatter, parsed as YAML (as Claude Code reads it); null when absent or not a map. */
function frontmatter(md: string): Record<string, unknown> | null {
  // The documented shape: `---` on the first line, `name:` on the next, nothing in between.
  const m = /^---\n(name: [\s\S]*?)\n---\n/.exec(md);
  if (!m) return null;
  const doc: unknown = yaml.load(m[1] ?? '', { schema: yaml.CORE_SCHEMA });
  return doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
}

/** The fenced `markdown` blocks of a file. */
function markdownBlocks(md: string): string[] {
  return [...md.matchAll(/^```markdown\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');
}

describe('skills', () => {
  test('every skill and shared file exists', () => {
    for (const s of SKILLS) expect(existsSync(join(ROOT, s, 'SKILL.md')), s).toBe(true);
    for (const s of SHARED) expect(existsSync(join(ROOT, 'shared', `${s}.md`)), s).toBe(true);
  });

  test('every skill has name and description frontmatter within length limits', () => {
    for (const s of SKILLS) {
      const fm = frontmatter(read(join(ROOT, s, 'SKILL.md')));
      expect(fm, s).not.toBeNull();
      expect(fm?.name).toBe(s);
      expect(String(fm?.name)).toMatch(/^[a-z0-9-]{1,64}$/);
      const description = fm?.description;
      expect(typeof description, s).toBe('string');
      expect(String(description).length, s).toBeGreaterThan(20);
      expect(String(description).length, s).toBeLessThanOrEqual(1024);
      expect(String(description)).not.toMatch(/[<>]/);
    }
  });

  test('every mcp__jumpmaster__<tool> named in a skill exists in TOOL_NAMES', () => {
    const named = new Set<string>();
    for (const f of markdownFiles())
      for (const m of read(f).matchAll(/mcp__jumpmaster__([a-z_]+)/g)) named.add(m[1] ?? '');
    expect(named.size).toBeGreaterThan(0);
    for (const n of named) expect(TOOL_NAMES, n).toContain(n);
    // The shared flow's two calls are named.
    expect([...named]).toEqual(expect.arrayContaining(['get_queue', 'file_staged_issues']));
  });

  test('the GOAL.md example in ladder-writer parses with parseGoals', () => {
    const blocks = markdownBlocks(read(join(ROOT, 'shared', 'ladder-writer.md'))).filter((b) =>
      b.includes('## Objectives'),
    );
    expect(blocks).toHaveLength(1);
    const p = parseGoals(blocks[0] ?? '');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.lighthouse.length).toBeGreaterThan(0);
    expect(p.objectives.length).toBeGreaterThanOrEqual(2);
    expect(currentObjective(p)?.title).toBe(p.objectives[0]?.title);
  });

  test('the issue template headings equal renderIssueSpec headings', () => {
    const blocks = markdownBlocks(read(join(ROOT, 'shared', 'issue-splitter.md'))).filter((b) =>
      b.includes('## Acceptance criteria'),
    );
    expect(blocks).toHaveLength(1);
    const headings = (md: string) =>
      md
        .split('\n')
        .filter((l) => /^##\s/.test(l))
        .map((l) => l.replace(/^##\s+/, '').trim());
    const rendered = renderIssueSpec({ context: 'c', acceptance: ['a'], tests: ['t'] });
    expect(headings(blocks[0] ?? '')).toEqual([...ISSUE_SPEC_HEADINGS]);
    expect(headings(blocks[0] ?? '')).toEqual(headings(rendered));
    // The template, as written, passes the checks file_staged_issues applies.
    expect(validateIssueSpec('A title', blocks[0] ?? '')).toEqual([]);
  });

  test('no skill mentions gh pr merge, gh issue edit --add-label, a token variable or ready labelling', () => {
    const banned: [string, RegExp][] = [
      ['gh pr merge', /gh\s+pr\s+merge/i],
      ['gh issue edit --add-label', /gh\s+issue\s+edit/i],
      ['--add-label', /--add-label/i],
      ['--label', /--label\b/i],
      [
        'a token variable',
        /\b(JM_[A-Z_]*TOKEN[A-Z_]*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b/,
      ],
      ['a token value', /\b(github_pat_|ghp_|gho_|sk-ant-)/],
      ['the ready label', /agent-ready|readyLabel/i],
      ['ready labelling', /\b(add|apply|set|put|mark)\w*\s+(\w+\s+){0,3}ready\b/i],
    ];
    for (const f of markdownFiles())
      for (const [what, re] of banned) expect(read(f), `${label(f)}: ${what}`).not.toMatch(re);
  });

  test('enabling the crew is never a step: it is a separate later choice that spends usage', () => {
    for (const f of markdownFiles()) {
      const text = read(f);
      expect(text, label(f)).not.toMatch(/crew\.enabled:\s*true/);
      expect(text, label(f)).not.toMatch(
        /\b(set|turn on|enable)\s+(the\s+)?(zone's\s+)?crew\b(?![^.]*\b(separate|later)\b)/i,
      );
    }
    const splitter = read(join(ROOT, 'shared', 'issue-splitter.md'));
    expect(splitter).toMatch(/separate[^.]*later[^.]*choice/i);
    expect(splitter).toMatch(/spends?\s+usage/i);
  });

  test('the flow ends at Command ruling Promote on the briefing in the web UI, crew on or off', () => {
    const splitter = read(join(ROOT, 'shared', 'issue-splitter.md'));
    expect(splitter).toMatch(/rule \*\*Promote\*\* on (its|the) briefing[^.]*web UI/i);
    expect(splitter).not.toMatch(/that waits/i);
    for (const s of SKILLS)
      expect(read(join(ROOT, s, 'SKILL.md')), s).toMatch(
        /rule \*\*Promote\*\*[^.]*Briefings page/i,
      );
  });

  test('no skill pushes a branch unless Command asks for it', () => {
    for (const f of markdownFiles())
      for (const line of read(f).split('\n'))
        if (
          /\bpush\b.*\bbranch\b|git push/i.test(line) &&
          !/never push|push to the default branch/i.test(line)
        )
          expect(line, label(f)).toMatch(/\b(ask|asks|asked|only if)\b/i);
    expect(read(join(ROOT, 'shared', 'ladder-writer.md'))).toMatch(/Ask Command whether to push/);
  });

  test('every relative link between skill files resolves', () => {
    let links = 0;
    for (const f of markdownFiles()) {
      for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] ?? '';
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        links++;
        const path = resolve(dirname(f), target.split('#')[0] ?? '');
        expect(existsSync(path), `${label(f)} → ${target}`).toBe(true);
      }
    }
    // Each skill links the shared flow it follows.
    expect(links).toBeGreaterThanOrEqual(SKILLS.length * SHARED.length);
  });
});
