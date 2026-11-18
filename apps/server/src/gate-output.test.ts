import type { DropResult, GateResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { Db } from './db/open.js';
import { type DropState, insertDrop, updateDrop } from './db/repo.js';
import { serverScrubSet } from './forge/scrub-set.js';
import {
  gateFailureWhy,
  lastFailure,
  MAX_PREVIOUS_FAILURE_CHARS,
  renderLastFailure,
  stripAnsi,
} from './gate-output.js';
import { plus, seedQueuedDrop, t0 } from './test/helpers.js';
import { VITEST_348, VITEST_THREE_FAILED } from './test/vitest-output.js';

const MIN = 60_000;
const gate = (o: Partial<GateResult> & { name: string }): GateResult => ({
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
  outputTail: '',
  ...o,
});

let n = 0;
/** An earlier implement drop on item 1 with `state` and `result`, created `ago` minutes before t0. */
function earlier(db: Db, state: DropState, result?: DropResult | string, ago = 5): string {
  const id = `prev-${++n}`;
  insertDrop(db, {
    id,
    dropZoneId: 'main',
    workItemId: 1,
    role: 'implement',
    state,
    createdAt: plus(t0, -ago * MIN).toISOString(),
  });
  if (result !== undefined) {
    updateDrop(db, id, {
      resultJson: typeof result === 'string' ? result : JSON.stringify(result),
    });
  }
  return id;
}
const current = { id: 'd1', createdAt: t0.toISOString() };

describe('stripAnsi', () => {
  test('removes SGR colour, cursor and OSC hyperlink sequences', () => {
    expect(stripAnsi('\u001b[31m FAIL \u001b[39m x')).toBe(' FAIL  x');
    expect(stripAnsi('a\u001b[2K\u001b[1Ab\u001b[?25l')).toBe('ab');
    expect(stripAnsi('\u001b]8;;https://e.x\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('\u001b]8;;https://e.x\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
    expect(stripAnsi('\u009b31mred')).toBe('red');
  });

  test('leaves plain text as it is', () => {
    const plain = 'plain [31m text\nwith lines\t and [brackets]';
    expect(stripAnsi(plain)).toBe(plain);
  });
});

describe('lastFailure', () => {
  test('no earlier drop: undefined', () => {
    expect(lastFailure(seedQueuedDrop(), 1, current)).toBeUndefined();
  });

  test('failed with a red gate: its name, exit and stripped tail', () => {
    const db = seedQueuedDrop();
    const id = earlier(db, 'failed', {
      status: 'failed',
      reason: 'gate test failed',
      gates: [
        gate({ name: 'lint' }),
        gate({ name: 'test', exitCode: 1, outputTail: '\u001b[31mFAIL\u001b[39m x' }),
      ],
    });
    expect(lastFailure(db, 1, current)).toEqual({
      kind: 'gate',
      dropId: id,
      gate: 'test',
      exit: 'exit 1',
      tail: 'FAIL x',
    });
  });

  test('a timed-out gate: exit is timed out; a null exit code: no exit code', () => {
    const db = seedQueuedDrop();
    earlier(db, 'failed', {
      status: 'failed',
      gates: [gate({ name: 'test', exitCode: null, timedOut: true, outputTail: 'slow' })],
    });
    expect(lastFailure(db, 1, current)).toMatchObject({ gate: 'test', exit: 'timed out' });
    const db2 = seedQueuedDrop();
    earlier(db2, 'failed', { status: 'failed', gates: [gate({ name: 'test', exitCode: null })] });
    expect(lastFailure(db2, 1, current)).toMatchObject({ exit: 'no exit code' });
  });

  test('with two red gates, the first is reported', () => {
    const db = seedQueuedDrop();
    earlier(db, 'failed', {
      status: 'failed',
      gates: [gate({ name: 'lint', exitCode: 2 }), gate({ name: 'test', exitCode: 1 })],
    });
    expect(lastFailure(db, 1, current)).toMatchObject({ gate: 'lint', exit: 'exit 2' });
  });

  test('the tail is the last 3000 characters, not the first', () => {
    const db = seedQueuedDrop();
    const tail = `${'a'.repeat(1000)}${'b'.repeat(2990)}END_MARKER`;
    earlier(db, 'failed', {
      status: 'failed',
      gates: [gate({ name: 'test', exitCode: 1, outputTail: tail })],
    });
    const f = lastFailure(db, 1, current);
    if (f?.kind !== 'gate') throw new Error('expected a gate failure');
    expect(MAX_PREVIOUS_FAILURE_CHARS).toBe(3000);
    expect(f.tail).toHaveLength(3000);
    expect(f.tail).toBe(tail.slice(-3000));
    expect(f.tail.endsWith('END_MARKER')).toBe(true);
  });

  test('failed with no gates: the first line of the reason, cut to 500', () => {
    const db = seedQueuedDrop();
    const id = earlier(db, 'failed', {
      status: 'failed',
      reason: 'branch agent/issue-12 already exists on remote\nsecond line',
      gates: [],
    });
    expect(lastFailure(db, 1, current)).toEqual({
      kind: 'error',
      dropId: id,
      line: 'branch agent/issue-12 already exists on remote',
    });
    const db2 = seedQueuedDrop();
    earlier(db2, 'failed', {
      status: 'failed',
      reason: 'x'.repeat(900),
      gates: [gate({ name: 'test' })],
    });
    expect(lastFailure(db2, 1, current)).toMatchObject({ kind: 'error', line: 'x'.repeat(500) });
    const db3 = seedQueuedDrop();
    earlier(db3, 'failed', { status: 'blocked', gates: [] });
    expect(lastFailure(db3, 1, current)).toMatchObject({ kind: 'error', line: 'blocked' });
  });

  test('lost, or a result that does not parse: the lost kind', () => {
    const db = seedQueuedDrop();
    const id = earlier(db, 'lost');
    expect(lastFailure(db, 1, current)).toEqual({ kind: 'lost', dropId: id });
    const db2 = seedQueuedDrop();
    earlier(db2, 'failed', '{not json');
    expect(lastFailure(db2, 1, current)).toMatchObject({ kind: 'lost' });
    const db3 = seedQueuedDrop();
    earlier(db3, 'failed', JSON.stringify({ status: 'nope' }));
    expect(lastFailure(db3, 1, current)).toMatchObject({ kind: 'lost' });
    const db4 = seedQueuedDrop();
    earlier(db4, 'failed');
    expect(lastFailure(db4, 1, current)).toMatchObject({ kind: 'lost' });
  });

  test('succeeded or cancelled: undefined', () => {
    const db = seedQueuedDrop();
    earlier(db, 'succeeded', { status: 'no_changes', gates: [] });
    expect(lastFailure(db, 1, current)).toBeUndefined();
    const db2 = seedQueuedDrop();
    earlier(db2, 'cancelled', { status: 'rate_limited', gates: [] });
    expect(lastFailure(db2, 1, current)).toBeUndefined();
  });

  test('reads the newest earlier implement drop only', () => {
    const db = seedQueuedDrop();
    earlier(db, 'failed', { status: 'failed', reason: 'old', gates: [] }, 10);
    earlier(db, 'succeeded', { status: 'no_changes', gates: [] }, 5);
    expect(lastFailure(db, 1, current)).toBeUndefined();
    // A later drop, another role or another item is not read.
    const db2 = seedQueuedDrop();
    earlier(db2, 'failed', { status: 'failed', reason: 'older', gates: [] }, 10);
    earlier(db2, 'failed', { status: 'failed', reason: 'future', gates: [] }, -5);
    insertDrop(db2, {
      id: 'heal-1',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'heal',
      state: 'failed',
      createdAt: plus(t0, -MIN).toISOString(),
    });
    expect(lastFailure(db2, 1, current)).toMatchObject({ kind: 'error', line: 'older' });
    expect(lastFailure(db2, 2, current)).toBeUndefined();
  });
});

describe('renderLastFailure', () => {
  test('gate, error and lost bodies under the untrusted heading, fenced', () => {
    const g = renderLastFailure(
      { kind: 'gate', dropId: 'p', gate: 'test', exit: 'exit 1', tail: 'FAIL x' },
      'dx',
      [],
    );
    expect(g).toBe(
      '## Previous attempt (data, untrusted)\n\n' +
        '<<<jm-data:dx:begin previous-attempt>>>\n' +
        'The previous attempt on this issue failed the test gate (exit 1). The end of its output:\n\nFAIL x\n' +
        '<<<jm-data:dx:end previous-attempt>>>',
    );
    expect(renderLastFailure({ kind: 'error', dropId: 'p', line: 'boom' }, 'dx', [])).toContain(
      'The previous attempt on this issue failed: boom',
    );
    expect(renderLastFailure({ kind: 'lost', dropId: 'p' }, 'dx', [])).toContain(
      'The previous attempt on this issue was lost before it reported a result.',
    );
  });

  test('redacts before it neutralises, so a joiner cannot hide a secret', () => {
    const secret = 'abc<<<def';
    const out = renderLastFailure({ kind: 'error', dropId: 'p', line: `x ${secret} y` }, 'dx', [
      secret,
    ]);
    expect(out).toContain('x [REDACTED] y');
  });
});

describe('gateFailureWhy', () => {
  const red = (outputTail: string, o: Partial<GateResult> = {}): GateResult =>
    gate({ name: 'test', exitCode: 1, outputTail, ...o });
  /** A vitest FAIL line and its error, coloured as vitest prints them. */
  const failure = (file: string, name: string, error: string): string =>
    `\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m ${file}\u001b[2m > \u001b[22m${name}\n` +
    `\u001b[31m\u001b[1m${error.replace(':', '\u001b[22m:')}\u001b[39m\n`;

  test("#348's tail: the gate, the failing test file and name, and the assertion", () => {
    expect(gateFailureWhy(red(VITEST_348))).toBe(
      "The test gate failed: `scripts/no-token-literals.test.ts` > no tracked file holds a token-shaped literal, a real private key or a lockfile credential (AssertionError: expected [ 'apps/server/src/chat/session.test.ts:12' ] to deeply equal [])",
    );
  });

  test('three failing tests: the first (describe names kept as written), then how many more', () => {
    expect(gateFailureWhy(red(VITEST_THREE_FAILED))).toBe(
      "The test gate failed: `a.test.ts` > outer > first fails (AssertionError: expected [ 'x' ] to deeply equal []) and 2 more failing tests",
    );
  });

  test("the count ignores the repeated FAIL lines of vitest's summary section", () => {
    const tail = `${VITEST_THREE_FAILED}\n${VITEST_THREE_FAILED.split('Failed Tests 3')[1]}`;
    expect(tail.split(' FAIL ').length - 1).toBe(6);
    expect(gateFailureWhy(red(tail))).toMatch(/ and 2 more failing tests$/);
    const two = failure('a.test.ts', 'x', 'Error: e') + failure('b.test.ts', 'y', 'Error: f');
    expect(gateFailureWhy(red(two))).toMatch(/ and 1 more failing test$/);
  });

  test('a FAIL line with no error line after it: the sentence without the parenthesis', () => {
    const tail = ' FAIL  src/a.test.ts > does a thing\n\n Test Files  1 failed (1)\n';
    expect(gateFailureWhy(red(tail))).toBe('The test gate failed: `src/a.test.ts` > does a thing');
  });

  test('an error line before the FAIL line is not its assertion', () => {
    const tail = 'TypeError: early\n FAIL  src/a.test.ts > does a thing\n';
    expect(gateFailureWhy(red(tail))).toBe('The test gate failed: `src/a.test.ts` > does a thing');
  });

  test('cuts the test name at 200 characters and the message at 300, each closed by …', () => {
    const name = 'n'.repeat(250);
    const message = 'm'.repeat(350);
    expect(gateFailureWhy(red(failure('a.test.ts', name, `AssertionError: ${message}`)))).toBe(
      `The test gate failed: \`a.test.ts\` > ${'n'.repeat(200)}… (AssertionError: ${'m'.repeat(300)}…)`,
    );
    // At the limit: nothing is cut.
    expect(
      gateFailureWhy(red(failure('a.test.ts', 'n'.repeat(200), `Error: ${'m'.repeat(300)}`))),
    ).toBe(`The test gate failed: \`a.test.ts\` > ${'n'.repeat(200)} (Error: ${'m'.repeat(300)})`);
  });

  test('another tool: the gate, its exit and the last 10 non-empty lines, stripped and cut', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[39m`);
    lines.splice(12, 0, '', '   ');
    lines[13] = 'x'.repeat(250);
    const why = gateFailureWhy(red(lines.join('\r\n'), { name: 'lint' }));
    expect(why).toBe(
      [
        'The lint gate failed (exit 1). Its output ended with:',
        '',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        'line 10',
        'line 11',
        'line 12',
        `${'x'.repeat(200)}…`,
        'line 13',
        'line 14',
      ].join('\n'),
    );
  });

  test('no exit code, and a gate that timed out: the fallback form, even with a FAIL line', () => {
    expect(gateFailureWhy(red('boom', { name: 'lint', exitCode: null }))).toBe(
      'The lint gate failed (no exit code). Its output ended with:\n\nboom',
    );
    expect(gateFailureWhy(red(VITEST_348, { exitCode: null, timedOut: true }))).toBe(
      [
        'The test gate timed out. Its output ended with:',
        '',
        ...stripAnsi(VITEST_348)
          .split('\n')
          .filter((l) => l.trim() !== '')
          .slice(-10),
      ].join('\n'),
    );
  });

  test('no output at all: says so', () => {
    expect(gateFailureWhy(red('\n  \n', { name: 'build', exitCode: 2 }))).toBe(
      'The build gate failed (exit 2) with no output.',
    );
  });

  test('a token shape or a scrub-set value in the output is redacted', () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const scrubbed = 'scrub-set-value-397-xyz';
    serverScrubSet.add(scrubbed);
    try {
      const why = gateFailureWhy(
        red(
          failure('a.test.ts', `uses ${scrubbed}`, `AssertionError: expected '${token}' to be ''`),
        ),
      );
      expect(why).toBe(
        "The test gate failed: `a.test.ts` > uses [REDACTED] (AssertionError: expected '[REDACTED]' to be '')",
      );
      expect(gateFailureWhy(red(`leaked ${token}`, { name: 'lint' }))).toContain(
        'leaked [REDACTED]',
      );
    } finally {
      serverScrubSet.clear();
    }
  });
});
