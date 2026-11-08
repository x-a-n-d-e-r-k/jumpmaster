import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { type Db, openDb } from './db/open.js';
import {
  currentObjective,
  type GoalParse,
  getGoals,
  PARSER_VERSION,
  parseGoals,
  refreshGoals,
} from './goals.js';
import { fakeForgePair } from './test/fakes.js';
import { plus, t0, tmpDbFile } from './test/helpers.js';

const ok = (p: GoalParse) => {
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  return p;
};

const DOC = `# Widgets

## Lighthouse

Every widget ships with docs.

## Objectives

### Ship the widget API (done)

The API is live.

### Document every endpoint

Each endpoint gets a page.

### Add examples

## Notes

Keep it short.
`;

describe('parseGoals', () => {
  test('### headings under Objectives become objectives in order', () => {
    const p = ok(parseGoals(DOC));
    expect(p.objectives.map((o) => o.title)).toEqual([
      'Ship the widget API',
      'Document every endpoint',
      'Add examples',
    ]);
    expect(p.objectives[1]?.body).toBe('Each endpoint gets a page.');
    expect(p.objectives[1]?.key).toBe('document-every-endpoint');
  });

  test('checkbox items become objectives when there are no headings', () => {
    const p = ok(
      parseGoals(
        '## Objectives\n\n- [x] First thing\n- [ ] Second thing\n  more detail\n- [X] Third\n- plain item\n',
      ),
    );
    expect(p.objectives.map((o) => [o.title, o.done])).toEqual([
      ['First thing', true],
      ['Second thing', false],
      ['Third', true],
    ]);
    expect(p.objectives[1]?.body).toBe('more detail');
  });

  test('[x] and a trailing (done) mark an objective done; the current objective is the first not done', () => {
    const p = parseGoals(DOC);
    expect(ok(p).objectives.map((o) => o.done)).toEqual([true, false, false]);
    expect(currentObjective(p)?.title).toBe('Document every endpoint');
    expect(currentObjective(parseGoals('## Objectives\n- [x] a\n- [x] b\n'))).toBeNull();
    expect(currentObjective({ ok: false, error: 'x' })).toBeNull();
  });

  test('Lighthouse text and other ## sections are kept', () => {
    const p = ok(parseGoals(DOC));
    expect(p.lighthouse).toBe('Every widget ships with docs.');
    expect(p.sections).toEqual({ Notes: 'Keep it short.' });
  });

  test('no Objectives section, or an empty one, is a parse error naming it', () => {
    expect(parseGoals('## Lighthouse\nx\n')).toEqual({
      ok: false,
      error: expect.stringMatching(/Objectives/),
    });
    expect(parseGoals('## Objectives\n\nNothing listed yet.\n## Notes\n')).toEqual({
      ok: false,
      error: expect.stringMatching(/Objectives/),
    });
  });

  test('repeated titles get distinct keys; keys survive a reordering', () => {
    const a = ok(parseGoals('## Objectives\n### Fix it\n### Fix it\n### Ship!\n'));
    expect(a.objectives.map((o) => o.key)).toEqual(['fix-it', 'fix-it-2', 'ship']);
    const b = ok(parseGoals('## Objectives\n### Ship!\n### Fix it\n'));
    expect(b.objectives.map((o) => o.key)).toEqual(['ship', 'fix-it']);
    const long = ok(parseGoals(`## Objectives\n### ${'word '.repeat(30)}\n`));
    expect(long.objectives[0]?.key.length).toBeLessThanOrEqual(60);
    expect(long.objectives[0]?.key).toMatch(/^[a-z0-9-]+$/);
  });

  test('headings inside fenced code blocks are ignored', () => {
    const p = ok(
      parseGoals(
        '## Objectives\n### Real\n```md\n### Not an objective\n## Not a section\n```\n~~~\n- [ ] nor this\n~~~\n',
      ),
    );
    expect(p.objectives.map((o) => o.title)).toEqual(['Real']);
    expect(p.objectives[0]?.body).toContain('### Not an objective');
    expect(p.sections).toEqual({});
  });
});

const zone = {
  id: 'main',
  crew: { goalPath: 'GOAL.md' },
} as unknown as DropZoneConfig;

describe('refreshGoals', () => {
  let db: Db;
  let f: ReturnType<typeof fakeForgePair>;
  beforeEach(() => {
    db = openDb(tmpDbFile());
    f = fakeForgePair({ issues: [], trusted: [] });
  });

  test('a missing file is stored as "GOAL.md not found", and a read error keeps the last good row', async () => {
    const missing = await refreshGoals(db, f.author, zone, 'main', t0);
    expect(missing).toMatchObject({ sha256: null, raw: null, parse: { ok: false } });
    expect(missing.parse).toEqual({ ok: false, error: 'GOAL.md not found' });
    f.state.files.set('main:GOAL.md', DOC);
    const good = await refreshGoals(db, f.author, zone, 'main', plus(t0, 1000));
    expect(good.parse.ok).toBe(true);
    f.author.getFileAt = async () => {
      throw new Error('fake 502');
    };
    await expect(refreshGoals(db, f.author, zone, 'main', plus(t0, 2000))).rejects.toThrow(/502/);
    expect(getGoals(db, 'main')).toEqual(good);
  });

  test('the file is re-parsed when its sha256 or PARSER_VERSION changes, and only then', async () => {
    f.state.files.set('main:GOAL.md', DOC);
    const first = await refreshGoals(db, f.author, zone, 'main', t0);
    expect(first.parserVersion).toBe(PARSER_VERSION);
    // Mark the stored parse so a re-parse is visible.
    db.prepare(`UPDATE goals SET parse_json = '{"ok":false,"error":"stale"}'`).run();
    const same = await refreshGoals(db, f.author, zone, 'main', plus(t0, 1000));
    expect(same.parse).toEqual({ ok: false, error: 'stale' });
    expect(same.readAt).toBe(plus(t0, 1000).toISOString());
    db.prepare('UPDATE goals SET parser_version = 0').run();
    const reparsed = await refreshGoals(db, f.author, zone, 'main', plus(t0, 2000));
    expect(reparsed.parse.ok).toBe(true);
    expect(reparsed.parserVersion).toBe(PARSER_VERSION);
    db.prepare(`UPDATE goals SET parse_json = '{"ok":false,"error":"stale"}'`).run();
    f.state.files.set('main:GOAL.md', `${DOC}\n### Later\n`);
    const changed = await refreshGoals(db, f.author, zone, 'main', plus(t0, 3000));
    expect(changed.parse.ok).toBe(true);
    expect(changed.sha256).not.toBe(first.sha256);
  });
});
