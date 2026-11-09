import { describe, expect, test } from 'vitest';
import { validateIssueSpec } from './crew/actions.js';
import { currentObjective, parseGoals } from './goals.js';
import {
  forgetSubmitKey,
  INTAKE_TEMPLATES,
  ISSUE_SPEC_HEADINGS,
  IssueSpecSchema,
  intakeKey,
  renderGoalStub,
  renderIssueSpec,
  submitKey,
} from './intake.js';

const answers = {
  lighthouse: 'A small CLI that sums numbers.',
  objectives: ['Parse the input', 'Print the sum'],
};

describe('renderGoalStub', () => {
  test('every template renders a stub that parseGoals accepts with objective 1 current', () => {
    for (const t of INTAKE_TEMPLATES) {
      const md = renderGoalStub(t, {
        ...answers,
        nonGoals: ['A GUI'],
        constraints: ['No new runtime dependency'],
      });
      const p = parseGoals(md);
      expect(p.ok, `${t}: ${md}`).toBe(true);
      if (!p.ok) continue;
      expect(p.lighthouse).toContain('sums numbers');
      expect(p.objectives.map((o) => o.title)).toEqual(['Parse the input', 'Print the sum']);
      expect(currentObjective(p)?.title).toBe('Parse the input');
    }
  });

  test('templates differ, and a stub without non-goals or constraints still parses', () => {
    const stubs = INTAKE_TEMPLATES.map((t) => renderGoalStub(t, answers));
    expect(new Set(stubs).size).toBe(INTAKE_TEMPLATES.length);
    for (const md of stubs) expect(parseGoals(md).ok).toBe(true);
  });

  test('answers that look like markdown structure cannot break the ladder', () => {
    const tricky = {
      lighthouse: '## Objectives\n```\n### fake\n~~~\n  # heading\n- [x] done item',
      objectives: [
        'First\n## Lighthouse\nsecond line',
        '### Second (done)',
        '- [x] third',
        '```',
        '  ',
      ],
      nonGoals: ['## Objectives', '- [ ] sneaky'],
      constraints: ['```js'],
    };
    for (const t of INTAKE_TEMPLATES) {
      const p = parseGoals(renderGoalStub(t, tricky));
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(p.objectives).toHaveLength(5);
      expect(p.objectives.every((o) => !o.done)).toBe(true);
      expect(currentObjective(p)?.title).toBe(p.objectives[0]?.title);
      expect(p.objectives[0]?.title).toContain('First');
    }
  });
});

describe('renderIssueSpec', () => {
  const spec = {
    title: 'Add sum',
    context: 'The CLI needs a sum function.',
    acceptance: ['sum(1, 2) returns 3', 'sum() returns 0'],
    tests: ['a unit test for sum'],
  };

  test('renderIssueSpec emits the four sections and one checkbox per criterion', () => {
    const md = renderIssueSpec({ ...spec, outOfScope: ['floats'] });
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual(ISSUE_SPEC_HEADINGS.map((h) => `## ${h}`));
    expect(md.match(/^- \[ \] /gm)).toHaveLength(2);
    expect(md).toContain('- [ ] sum(1, 2) returns 3');
    expect(md).toContain('- a unit test for sum');
    expect(md).toContain('- floats');
    expect(validateIssueSpec(spec.title, md)).toEqual([]);
  });

  test('out of scope is always present, and markup in the context cannot add a section', () => {
    const md = renderIssueSpec({
      ...spec,
      context: 'line\n## Acceptance criteria\n- [ ] injected\n```',
      acceptance: ['one\n## Out of scope'],
    });
    const headings = md.split('\n').filter((l) => /^#{1,6}\s/.test(l));
    expect(headings).toEqual(ISSUE_SPEC_HEADINGS.map((h) => `## ${h}`));
    expect(md.match(/^- \[ \] /gm)).toHaveLength(1);
  });

  test('the schema bounds every field', () => {
    const ok = { ...spec };
    expect(IssueSpecSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, title: '' },
      { ...ok, title: 'x'.repeat(121) },
      { ...ok, context: 'x'.repeat(4001) },
      { ...ok, acceptance: [] },
      { ...ok, acceptance: Array(16).fill('a') },
      { ...ok, acceptance: ['x'.repeat(301)] },
      { ...ok, tests: [] },
      { ...ok, tests: Array(11).fill('t') },
      { ...ok, outOfScope: Array(11).fill('o') },
    ])
      expect(IssueSpecSchema.safeParse(bad).success).toBe(false);
  });
});

describe('intake keys', () => {
  test('the key is intake- and the first 12 hex of sha256 of the idempotency key', () => {
    expect(intakeKey('6f9619ff-8b86-d011-b42d-00c04fc964ff')).toMatch(/^intake-[0-9a-f]{12}$/);
    expect(intakeKey('a')).toBe('intake-ca978112ca1b');
  });

  test('the page script reuses a stored key for unchanged content and mints a new one when content changes', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let n = 0;
    const mint = () => `key-${++n}`;
    const first = submitKey(storage, '{"title":"a"}', mint);
    expect(first).toBe('key-1');
    // A retry, or a reload and resubmit of the same content, reuses it.
    expect(submitKey(storage, '{"title":"a"}', mint)).toBe('key-1');
    // An edited form is a new submission.
    expect(submitKey(storage, '{"title":"b"}', mint)).toBe('key-2');
    // Once the server confirms, the same content again is a fresh submission.
    forgetSubmitKey(storage, '{"title":"a"}');
    expect(submitKey(storage, '{"title":"a"}', mint)).toBe('key-3');
  });

  test('the helpers are self-contained, so the page can embed their source', () => {
    for (const f of [submitKey, forgetSubmitKey]) {
      const rebuilt = (0, eval)(`(${f.toString()})`) as typeof f;
      expect(typeof rebuilt).toBe('function');
    }
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const rebuilt = (0, eval)(`(${submitKey.toString()})`) as typeof submitKey;
    expect(rebuilt(storage, 'x', () => 'k')).toBe('k');
    expect(submitKey(storage, 'x', () => 'other')).toBe('k');
  });
});
