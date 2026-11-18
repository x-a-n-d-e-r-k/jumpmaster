import type { Db } from '../db/open.js';
import { escapeHtml } from '../ui/pages.js';

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

/** One card as HTML: every field escaped; Undo only where the action can be reversed. */
export function renderCard(c: ChatCard): string {
  const link = safeCardLink(c.link);
  const state = CARD_STATE_TEXT[c.state];
  return (
    `<div class="msg card ${escapeHtml(c.state)}" data-card="${c.id}">` +
    `<div class="who">${escapeHtml(CARD_TITLE[c.kind] ?? c.kind)}</div>` +
    `<div class="text">${escapeHtml(c.summary)}</div>` +
    (state ? `<small class="state">${escapeHtml(state)}</small>` : '') +
    (link ? `<a href="${escapeHtml(link)}">Open</a>` : '') +
    (cardUndoable(c)
      ? ` <button type="button" class="undo" data-card="${c.id}">Undo</button>`
      : '') +
    '</div>'
  );
}
