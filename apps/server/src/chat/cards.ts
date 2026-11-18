import { type ActionCtx, type ActionResult, configPatchAction } from '../api/operator-actions.js';
import type { ConfigStore } from '../config/store.js';
import type { Db } from '../db/open.js';
import { escapeHtml } from '../ui/pages.js';
import { changedSince } from './inverse.js';

/**
 * The crew chat's cards (#336, Task 13): one per action a chat turn took or was refused. A card's
 * text comes from the server's record of the action (the briefing it ruled, the zone it paused),
 * never from the model's arguments, and it belongs to the thread and message of the chat token
 * that acted, whatever the arguments say.
 */

export const CARD_KINDS = [
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
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type CardState = 'done' | 'pending' | 'refused' | 'undone';

export type NewCard = {
  threadId: number;
  messageId: number;
  kind: CardKind;
  zoneId?: string | null;
  /** What the action was on: `briefing:<id>`, a zone id, `objective:<key>`. */
  target?: string | null;
  /** Where the owner sees it: a same-site path or an https URL (the issue, the PR). */
  link?: string | null;
  state: CardState;
  summary: string;
  /** What Undo needs; absent where there is no Undo (a ruling has none). */
  undo?: unknown;
};

export type ChatCard = {
  id: number;
  threadId: number;
  messageId: number;
  kind: CardKind;
  zoneId: string | null;
  target: string | null;
  link: string | null;
  state: CardState;
  summary: string;
  undo: unknown;
  createdAt: string;
  undoneAt: string | null;
};

const COLS = `id, thread_id AS threadId, message_id AS messageId, kind, zone_id AS zoneId, target,
  link, state, summary, undo_json AS undoJson, created_at AS createdAt, undone_at AS undoneAt`;

type CardRow = Omit<ChatCard, 'undo'> & { undoJson: string | null };
const toCard = ({ undoJson, ...r }: CardRow): ChatCard => ({
  ...r,
  undo: undoJson === null ? null : (JSON.parse(undoJson) as unknown),
});

export function recordCard(db: Db, c: NewCard, now: Date): ChatCard {
  const row = db
    .prepare(
      `INSERT INTO chat_cards (thread_id, message_id, kind, zone_id, target, link, state, summary,
         undo_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    )
    .get(
      c.threadId,
      c.messageId,
      c.kind,
      c.zoneId ?? null,
      c.target ?? null,
      c.link ?? null,
      c.state,
      c.summary,
      c.undo === undefined || c.undo === null ? null : JSON.stringify(c.undo),
      now.toISOString(),
    ) as CardRow;
  return toCard(row);
}

/** A thread's cards, oldest first. */
export function listCards(db: Db, threadId: number): ChatCard[] {
  return (
    db
      .prepare(`SELECT ${COLS} FROM chat_cards WHERE thread_id = ? ORDER BY id`)
      .all(threadId) as CardRow[]
  ).map(toCard);
}

/** What a card's kind is called on the page. */
export const CARD_TITLE: Record<CardKind, string> = {
  file_issues: 'Filed issues',
  briefing: 'Briefing',
  rule: 'Ruling',
  pause: 'Paused',
  resume: 'Resumed',
  crew_cycle: 'Crew cycle',
  objective_done: 'Objective done',
  queue: 'Work on it',
  retry: 'Retry',
  close: 'Closed',
  setting: 'Setting',
  goal_change: 'Goal change',
};

export const CARD_STATE_TEXT: Record<CardState, string> = {
  done: '',
  pending: 'Waiting for you to confirm',
  refused: 'Refused',
  undone: 'Undone',
};

/** A link the page may follow: a same-site path, or an https URL. Anything else is dropped. */
export function safeCardLink(link: string | null): string | null {
  if (!link) return null;
  if (link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\')) return link;
  return /^https:\/\/[^\s"'<>]+$/.test(link) ? link : null;
}

/** Whether the card offers Undo: it has what Undo needs and is still done. */
export const cardUndoable = (c: ChatCard): boolean => c.undo !== null && c.state === 'done';

/** The confirm page of a pending guarded change: the only link a pending card offers as Confirm. */
const CONFIRM_LINK = /^\/config\/confirm\/[\w-]+$/;

/** What a card's link is called: Confirm for a pending change's confirm page, else Open. */
export const cardLinkText = (c: Pick<ChatCard, 'state' | 'link'>): string =>
  c.state === 'pending' && c.link && CONFIRM_LINK.test(c.link) ? 'Confirm' : 'Open';

/** One card as HTML: every field escaped; Undo only where the action can be reversed. */
export function renderCard(c: ChatCard): string {
  const link = safeCardLink(c.link);
  const state = CARD_STATE_TEXT[c.state];
  return (
    `<div class="msg card ${escapeHtml(c.state)}" data-card="${c.id}">` +
    `<div class="who">${escapeHtml(CARD_TITLE[c.kind] ?? c.kind)}</div>` +
    `<div class="text">${escapeHtml(c.summary)}</div>` +
    (state ? `<small class="state">${escapeHtml(state)}</small>` : '') +
    (link ? `<a href="${escapeHtml(link)}">${cardLinkText(c)}</a>` : '') +
    (cardUndoable(c)
      ? ` <button type="button" class="undo" data-card="${c.id}">Undo</button>`
      : '') +
    '</div>'
  );
}

/** A setting card's Undo: the inverse patch of just its change, and what it must still find. */
export type SettingUndo = { revision: number; patch: unknown; expect: Record<string, unknown> };

const isSettingUndo = (u: unknown): u is SettingUndo =>
  typeof u === 'object' &&
  u !== null &&
  typeof (u as SettingUndo).revision === 'number' &&
  typeof (u as SettingUndo).expect === 'object' &&
  (u as SettingUndo).expect !== null &&
  (u as SettingUndo).patch !== undefined;

/** Marks a done card undone; false when it no longer was done (a second press). */
export function markCardUndone(db: Db, id: number, now: Date): boolean {
  return (
    db
      .prepare(
        "UPDATE chat_cards SET state = 'undone', undone_at = ? WHERE id = ? AND state = 'done'",
      )
      .run(now.toISOString(), id).changes === 1
  );
}

/**
 * Undoes a setting card: its inverse patch through the config store as the context's principal,
 * exactly like any other change (so an Undo that loosens a guard is held for confirmation, 409,
 * and a browser-forbidden one refused, 403). Refused with "changed since", writing nothing, when a
 * path it would restore no longer holds what the change set. Applied, the card is undone.
 */
export function undoSettingCard(
  ctx: ActionCtx,
  store: ConfigStore,
  card: ChatCard,
): ActionResult<{ state: 'undone'; revision: number }> {
  if (card.kind !== 'setting' || !isSettingUndo(card.undo))
    return { ok: false, status: 400, error: 'this card has no Undo' };
  if (card.state !== 'done')
    return { ok: false, status: 409, error: `this card is ${card.state}, not done` };
  const undo = card.undo;
  const moved = changedSince(store.document(), undo.expect);
  if (moved.length > 0)
    return {
      ok: false,
      status: 409,
      error: 'the setting changed since: Undo writes nothing',
      body: { changedSince: moved },
    };
  const r = configPatchAction(ctx, store, undo.patch, {
    expectRevision: store.revision(),
    note: `undo of chat card ${card.id} (revision ${undo.revision})`,
    returnTo: `/chat/${card.threadId}`,
  });
  if (!r.ok) return r;
  markCardUndone(ctx.db, card.id, ctx.now());
  return { ok: true, value: { state: 'undone', revision: r.value.revision } };
}
