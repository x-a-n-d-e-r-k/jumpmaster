import { describe, expect, test } from 'vitest';
import { MIGRATIONS } from '../db/migrations.js';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import { CARD_KINDS, listCards, recordCard, renderCard } from './cards.js';

const later = new Date(t0.getTime() + 60_000);

describe('chat cards', () => {
  test('v43 creates chat_cards with the card states as a CHECK', () => {
    expect(MIGRATIONS.some((m) => m.version === 43)).toBe(true);
    const db = openDb(tmpDbFile());
    const put = db.prepare(
      `INSERT INTO chat_cards (thread_id, message_id, kind, state, summary, created_at)
       VALUES (1, 1, 'rule', ?, 's', 't')`,
    );
    for (const s of ['done', 'pending', 'refused', 'undone']) put.run(s);
    expect(() => put.run('maybe')).toThrow(/CHECK/);
  });

  test('recordCard stores a card and listCards returns a thread its own cards in order', () => {
    const db = openDb(tmpDbFile());
    const a = recordCard(
      db,
      {
        threadId: 1,
        messageId: 5,
        kind: 'pause',
        zoneId: 'main',
        target: 'main',
        link: '/projects/main',
        state: 'done',
        summary: 'Paused zone main',
      },
      t0,
    );
    recordCard(db, { threadId: 2, messageId: 6, kind: 'rule', state: 'refused', summary: 'x' }, t0);
    const b = recordCard(
      db,
      {
        threadId: 1,
        messageId: 7,
        kind: 'resume',
        state: 'done',
        summary: 'Resumed',
        undo: { a: 1 },
      },
      later,
    );
    expect(a).toEqual({
      id: expect.any(Number),
      threadId: 1,
      messageId: 5,
      kind: 'pause',
      zoneId: 'main',
      target: 'main',
      link: '/projects/main',
      state: 'done',
      summary: 'Paused zone main',
      undo: null,
      createdAt: t0.toISOString(),
      undoneAt: null,
    });
    expect(listCards(db, 1)).toEqual([a, b]);
    expect(b.undo).toEqual({ a: 1 });
  });

  test('the card kinds are the documented set', () => {
    expect([...CARD_KINDS].sort()).toEqual(
      [
        'file_issues',
        'briefing',
        'rule',
        'pause',
        'resume',
        'crew_cycle',
        'objective_done',
        'queue',
        'retry',
        'close',
        'setting',
        'goal_change',
      ].sort(),
    );
  });

  test('renderCard escapes the summary, keeps only a same-site or https link, and offers Undo only when it can', () => {
    const db = openDb(tmpDbFile());
    const card = (o: Partial<Parameters<typeof recordCard>[1]>) =>
      recordCard(
        db,
        { threadId: 1, messageId: 1, kind: 'rule', state: 'done', summary: 's', ...o },
        t0,
      );
    const html = renderCard(card({ summary: '<script>x</script>', link: 'javascript:alert(1)' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/Undo/);
    expect(renderCard(card({ link: '/briefings#briefing-3' }))).toContain(
      'href="/briefings#briefing-3"',
    );
    expect(renderCard(card({ link: '//evil.example/x' }))).not.toContain('evil.example');
    expect(renderCard(card({ kind: 'queue', undo: { label: 'agent-ready' } }))).toMatch(
      /<button[^>]*>Undo<\/button>/,
    );
    // Refused or undone cards are not undone again.
    expect(renderCard(card({ kind: 'queue', state: 'refused', undo: { x: 1 } }))).not.toMatch(
      /Undo/,
    );
    expect(renderCard(card({ state: 'refused' }))).toMatch(/Refused/);
  });
});
