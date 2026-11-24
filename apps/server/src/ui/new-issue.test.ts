import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { ISSUE_SCRIPT, renderNewIssue } from './pages.js';

type El = {
  id: string;
  value: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  children: unknown[];
  disabled?: boolean;
  focused?: boolean;
  listeners: Record<string, ((e: unknown) => unknown)[]>;
  addEventListener: (ev: string, fn: (e: unknown) => unknown) => void;
  replaceChildren: (...xs: unknown[]) => void;
  reset: () => void;
  focus: () => void;
};

const FIELDS = ['issue-title', 'issue-context', 'issue-acceptance', 'issue-tests', 'issue-out'];

/** Runs ISSUE_SCRIPT against a fake DOM and a fake `jmFetch` answering `answer`. */
function newIssue(answer: { status: number; body: unknown }) {
  const els: Record<string, El> = {};
  const el = (id: string, extra: Partial<El> = {}): El => {
    const e: El = {
      id,
      value: '',
      textContent: '',
      hidden: false,
      dataset: {},
      children: [],
      listeners: {},
      addEventListener(ev, fn) {
        (e.listeners[ev] ??= []).push(fn);
      },
      replaceChildren(...xs) {
        e.children = xs;
        e.textContent = '';
      },
      reset() {
        for (const f of FIELDS) els[f]!.value = '';
      },
      focus() {
        e.focused = true;
      },
      ...extra,
    };
    els[id] = e;
    return e;
  };
  el('new-issue', {
    dataset: {
      base: '/api/control/zones/jm/intake',
      issues: 'https://github.com/octo/jm/issues/',
    },
  });
  el('issue-form');
  el('issue-status');
  el('issue-again', { hidden: true });
  for (const f of FIELDS) el(f);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const storage = new Map<string, string>();
  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: (tag: string) => ({ tag, href: '', textContent: '' }),
    },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    crypto: { randomUUID: () => 'uuid-1' },
    jmFetch: async (url: string, body: Record<string, unknown>) => {
      calls.push({ url, body });
      return { status: answer.status, json: async () => answer.body };
    },
  });
  vm.runInContext(ISSUE_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
  const submit = async () => {
    const button = { disabled: false };
    for (const fn of els['issue-form']!.listeners.submit ?? [])
      await fn({ preventDefault: () => {}, submitter: button });
  };
  return { els, calls, submit };
}

describe('the New issue page (#500)', () => {
  test('the page embeds the issue script, and the script is free of the stub form', () => {
    const html = renderNewIssue({ id: 'jm', repo: 'octo/jm' });
    expect(html).toContain(ISSUE_SCRIPT);
    expect(html).toContain('data-issues="https://github.com/octo/jm/issues/"');
    expect(ISSUE_SCRIPT).not.toContain('stub-');
  });

  test('submitting posts the same body to the intake issue endpoint, with exactly its keys', async () => {
    const w = newIssue({ status: 201, body: { number: 42, state: 'promoted' } });
    w.els['issue-title']!.value = ' Add a thing ';
    w.els['issue-context']!.value = 'Why';
    w.els['issue-acceptance']!.value = 'one\n\n two ';
    w.els['issue-tests']!.value = 'a test';
    w.els['issue-out']!.value = 'not this';
    await w.submit();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url).toBe('/api/control/zones/jm/intake/issue');
    const body = w.calls[0]!.body;
    expect(Object.keys(body).sort()).toEqual(
      ['acceptance', 'context', 'idempotencyKey', 'outOfScope', 'tests', 'title'].sort(),
    );
    expect(body).toEqual({
      idempotencyKey: 'uuid-1',
      title: 'Add a thing',
      context: 'Why',
      acceptance: ['one', 'two'],
      tests: ['a test'],
      outOfScope: ['not this'],
    });
  });

  test('an empty out-of-scope field is left out of the body', async () => {
    const w = newIssue({ status: 201, body: { number: 1, state: 'promoted' } });
    w.els['issue-title']!.value = 'T';
    await w.submit();
    expect(Object.keys(w.calls[0]!.body).sort()).toEqual(
      ['acceptance', 'context', 'idempotencyKey', 'tests', 'title'].sort(),
    );
  });

  test("a filing shows the issue's link and a File another button that clears the form", async () => {
    const w = newIssue({ status: 201, body: { number: 42, state: 'promoted' } });
    w.els['issue-title']!.value = 'T';
    w.els['issue-context']!.value = 'C';
    await w.submit();
    const status = w.els['issue-status']!;
    expect(status.children).toEqual([
      'Filed as ',
      { tag: 'a', href: 'https://github.com/octo/jm/issues/42', textContent: 'issue #42' },
      ', ready. It starts on the next pass.',
    ]);
    const again = w.els['issue-again']!;
    expect(again.hidden).toBe(false);
    for (const fn of again.listeners.click ?? []) fn({});
    expect(w.els['issue-title']!.value).toBe('');
    expect(w.els['issue-context']!.value).toBe('');
    expect(status.textContent).toBe('');
    expect(status.children).toEqual([]);
    expect(again.hidden).toBe(true);
    expect(w.els['issue-title']!.focused).toBe(true);
  });

  test('a refusal says so and offers no File another', async () => {
    const w = newIssue({ status: 429, body: { error: 'slow down' } });
    await w.submit();
    expect(w.els['issue-status']!.textContent).toBe('Refused: 429 slow down');
    expect(w.els['issue-again']!.hidden).toBe(true);
  });
});
