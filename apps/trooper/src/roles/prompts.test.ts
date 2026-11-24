import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const prompt = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../prompts', name), 'utf8');

describe('the drop-ready format in the prompts (#198)', () => {
  test.each(['crew-lead.md', 'refute.md', 'triage.md'])(
    '%s names the drop-ready format',
    (name) => {
      const text = prompt(name);
      expect(text).toContain('drop-ready format');
      expect(text).not.toContain('agent-ready');
    },
  );
});

describe('finishing an objective (#245)', () => {
  test('the crew lead reports objectiveDone once every part has merged, not a free-text briefing', () => {
    const text = prompt('crew-lead.md');
    expect(text).toMatch(
      /every part of the current objective has merged, report it with `objectiveDone`/,
    );
    expect(text).toMatch(/instead of raising a free-text briefing/);
  });
});

describe('one open briefing per objective (#246)', () => {
  test('the crew lead reuses an open briefing for the current objective instead of raising another', () => {
    const text = prompt('crew-lead.md');
    expect(text).toMatch(/While a briefing is open for the current objective/);
    expect(text).toMatch(/don't raise another; reuse its subject to update it/);
  });
});

describe('the audit prompt (#385)', () => {
  test('audit.md names the drop-ready format and never reverts', () => {
    const text = prompt('audit.md');
    expect(text).toContain('drop-ready format');
    expect(text).toContain('## Required tests');
    expect(text).toMatch(/never propose a revert/);
    expect(text).toMatch(/You never revert, reopen/);
    expect(text).toContain('git show <sha>');
    expect(text).toContain('UNRUN');
    expect(text).toContain('<<<jm-data:<id>:begin NAME>>>');
    expect(text).toMatch(/Never modify, commit or push anything/);
    expect(text).toMatch(/no environment variable values/);
  });
});

describe('proposing a goal change (#364)', () => {
  test('the crew lead proposes a goal change only through goalChange', () => {
    const text = prompt('crew-lead.md');
    expect(text).toMatch(/Propose a goal change only through `goalChange`/);
    expect(text).not.toMatch(/Raise a briefing to propose a goal change/);
  });
});

describe('already done (#466)', () => {
  test('triage.md describes already-done: on the default branch, cited and checked', () => {
    const text = prompt('triage.md');
    expect(text).toContain(
      'Return `already-done` only when the work the issue asks for is already on the default branch',
    );
    expect(text).toMatch(
      /merged pull requests \(`pulls`\) or the issues closed as completed \(`issues`\)/,
    );
    expect(text).toMatch(/each one you checked in the repository/);
    expect(text).toContain('Last attempt refused');
  });
});

describe('a goal change in flight (#645)', () => {
  test('rule 8 forbids a briefing asking Command to merge an in-flight goal change', () => {
    const rule8 = prompt('crew-lead.md')
      .split('\n')
      .find((l) => l.startsWith('8. '));
    expect(rule8).toMatch(
      /A goal change listed in flight is already in front of Command: never raise a briefing asking Command to merge, confirm or approve it; work that depends on it waits, and your summary says so\.$/,
    );
    expect(rule8).toMatch(/^8\. Propose a goal change only through `goalChange`/);
  });
});

describe("a ruling's note (#767)", () => {
  const rule = (n: number): string =>
    prompt('crew-lead.md')
      .split('\n')
      .find((l) => l.startsWith(`${n}. `)) ?? '';

  test('rule 1 says a note is part of the ruling, wins over the option, and how to act on it', () => {
    const rule1 = rule(1);
    expect(rule1).toMatch(/^1\. Steer toward the current objective\./);
    expect(rule1).toContain('part of the ruling');
    expect(rule1).toContain('the note wins');
    expect(rule1).toContain('raise a briefing that quotes the note');
    expect(rule1).toMatch(/without carrying its note/);
  });

  test('rule 1 names rule 5 as the limit on filing a note’s work', () => {
    expect(rule(1)).toMatch(/When rule 5 forbids it as an issue/);
    expect(rule(1)).toMatch(
      /A note never lifts rule 5 or rule 10: protected work still goes to a briefing\./,
    );
  });

  test('rule 9 names rulings with their note', () => {
    expect(rule(9)).toMatch(/and with their note, if they have one/);
  });

  test('the prompt still has rules 1 to 12, in order', () => {
    const numbers = prompt('crew-lead.md')
      .split('\n')
      .map((l) => /^(\d+)\. /.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
