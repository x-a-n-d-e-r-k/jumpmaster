import { redact } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActionCtx } from '../api/operator-actions.js';
import { configReader, type LiveConfig } from '../config/source.js';
import type { ConfigStore } from '../config/store.js';
import type { Db } from '../db/open.js';
import type { ForgePair } from '../outbox.js';
import { redactionList } from '../scrub.js';
import { sliceWhole } from '../slice-whole.js';
import { messageTextHtml } from '../ui/chat.js';
import {
  type ChatCard,
  cardUndoable,
  getCard,
  safeCardLink,
  undoCard,
  undoSettingCard,
} from './cards.js';
import { focusKnown, focusTitle } from './focus.js';
import {
  appendMessage,
  type ChatMessage,
  createThread,
  getThread,
  hasOwnerMessage,
  listMessages,
  listThreads,
  resultStepsUpTo,
  SESSION_BOUND_FOCUS,
  setThreadTitle,
  threadBusy,
} from './store.js';
import type { HubEvent } from './turns.js';

/** The longest owner message, in characters. */
export const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_TITLE = 'New chat';
/** The longest title a thread takes from its first message, `…` included. */
export const MESSAGE_TITLE_CHARS = 60;

/**
 * A thread's title from its first owner message (#492): whitespace collapsed, a leading heading
 * marker (`#`s then whitespace or the end) off, so `#105` stays, and cut at a word boundary with
 * `…` to at most MESSAGE_TITLE_CHARS, never inside a surrogate pair. Empty when nothing is left.
 */
export function titleFromMessage(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+(?:\s+|$)/, '')
    .trim();
  if (flat.length <= MESSAGE_TITLE_CHARS) return flat;
  const room = flat.slice(0, MESSAGE_TITLE_CHARS);
  const space = room.lastIndexOf(' ');
  const cut = space > 0 ? room.slice(0, space) : room;
  return `${sliceWhole(cut.trimEnd(), MESSAGE_TITLE_CHARS - 1)}…`;
}

export interface ChatRouteDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  /** Starts the thread's next queued turn (Task 7); absent, messages wait as `queued`. */
  turns?: ChatTurnHub;
  /** The zone's author pair, which Undo writes through; absent, Undo is a 503. */
  forgesFor?: (zoneId: string) => ForgePair;
  /** The config store a setting card's Undo applies through; absent, that Undo is a 503. */
  store?: ConfigStore;
}

/** What the routes need of the turn runner (`ChatTurns`). */
export interface ChatTurnHub {
  enqueue(threadId: number): void;
  /** Absent, the events route replays the stored messages only. */
  subscribe?(threadId: number, afterSeq: number, fn: (e: HubEvent) => void): () => void;
  /** Sends a chat action's card to its thread's subscribers. */
  publishCard?(card: ChatCard): void;
}

/** The names of the events `GET /api/chat/threads/:id/events` sends; each carries `id: <seq>`. */
export const CHAT_SSE_EVENTS = ['message', 'text', 'tool', 'card', 'done'] as const;
export type ChatSseEvent = (typeof CHAT_SSE_EVENTS)[number];

/** How often an open stream sends a comment, so proxies keep it open. */
const HEARTBEAT_MS = 25_000;

/** A message as the browser gets it: without the posting session's hash. */
const publicMessage = ({ sessionHash: _hash, ...m }: ChatMessage) => m;

/** A card as the browser gets it: what Undo needs stays on the server. */
export const publicCard = ({ undo: _undo, link, ...c }: ChatCard) => ({
  ...c,
  link: safeCardLink(link),
  undoable: cardUndoable({ ...c, link, undo: _undo }),
});

/** The seq a reconnecting browser last saw: `Last-Event-ID`, else `?after=`, else 0. */
function afterSeqOf(req: FastifyRequest): number {
  const header = req.headers['last-event-id'];
  const query = (req.query as { after?: unknown } | undefined)?.after;
  for (const v of [Array.isArray(header) ? header[0] : header, query]) {
    if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  }
  return 0;
}

const FocusBody = z.strictObject({
  kind: z.enum(['zone', 'goals', 'briefing', 'drop', 'doctor']),
  zoneId: z.string().min(1).max(200),
  ref: z.string().min(1).max(200),
});
const NewThreadBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** What the thread is about ("Ask about this"): its first turn is given the object's context. */
  focus: FocusBody.optional(),
});
const MessageBody = z.object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS) });

/**
 * The browser session behind a chat request. The guard has already required a principal (and CSRF
 * on a POST); the chat refuses the Bearer token too, because a guarded change a chat turn asks for
 * binds to the session that posted the message (R6).
 */
function sessionOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const p = req.principal;
  if (!p) {
    void reply.code(401).send({ error: 'sign in first' });
    return undefined;
  }
  if (p.via !== 'session' || !p.sessionId) {
    void reply.code(403).send({ error: 'the chat is for a signed-in browser only' });
    return undefined;
  }
  return p.sessionId;
}

export function threadIdOf(raw: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { db } = deps;
  const config = configReader(deps.config);

  app.get('/api/chat/threads', async (req, reply) => {
    const viewer = sessionOf(req, reply);
    if (!viewer) return reply;
    return { threads: listThreads(db, 100, viewer) };
  });

  app.post('/api/chat/threads', async (req, reply) => {
    const session = sessionOf(req, reply);
    if (!session) return reply;
    const body = NewThreadBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error:
          'a title is 1 to 200 characters, and a focus a zone, goals, briefing, drop or doctor check',
      });
    }
    const { focus } = body.data;
    if (focus && !focusKnown(db, config(), focus)) {
      // Fixed words: the ref is never echoed.
      if (focus.kind === 'drop') return reply.code(400).send({ error: 'unknown drop' });
      if (focus.kind === 'doctor') {
        return reply
          .code(400)
          .send({ error: 'unknown doctor check: it is not in the latest doctor run' });
      }
      return reply
        .code(404)
        .send({ error: `unknown ${focus.kind === 'briefing' ? 'briefing' : 'zone'}` });
    }
    const title = body.data.title ?? (focus ? focusTitle(db, config(), focus) : DEFAULT_TITLE);
    // A drop or doctor focus carries gate output and findings: its thread is this session's own.
    const owner = focus && SESSION_BOUND_FOCUS.includes(focus.kind) ? session : undefined;
    return {
      thread: createThread(
        db,
        { title, ...(focus ? { focus } : {}), ...(owner ? { owner } : {}) },
        deps.now(),
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/api/chat/threads/:id', async (req, reply) => {
    const viewer = sessionOf(req, reply);
    if (!viewer) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id, viewer);
    if (!thread) return reply.code(404).send({ error: 'unknown thread' });
    return { thread, messages: listMessages(db, thread.id) };
  });

  app.post<{ Params: { id: string } }>('/api/chat/threads/:id/messages', async (req, reply) => {
    const sessionHash = sessionOf(req, reply);
    if (!sessionHash) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id, sessionHash);
    if (!thread) return reply.code(404).send({ error: 'unknown thread' });
    const body = MessageBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: `a message is 1 to ${MAX_MESSAGE_CHARS} characters of text` });
    }
    const now = deps.now();
    const message = db.transaction(() => {
      if (thread.title === DEFAULT_TITLE && !hasOwnerMessage(db, thread.id)) {
        const title = titleFromMessage(body.data.text);
        if (title) setThreadTitle(db, thread.id, title, now);
      }
      return appendMessage(
        db,
        thread.id,
        { role: 'owner', text: body.data.text, state: 'queued', sessionHash },
        now,
      );
    })();
    deps.turns?.enqueue(thread.id);
    return reply.code(202).send({ message });
  });

  /**
   * Undo on one card, from the browser that shows it: a label comes off or an issue is reopened,
   * once (a second press is a 409); a setting goes back through the config store as this session,
   * like any other change (a guard it loosens waits for this session's Confirm, 409). The card
   * goes to its thread's stream as undone.
   */
  app.post<{ Params: { id: string } }>('/api/chat/cards/:id/undo', async (req, reply) => {
    const viewer = sessionOf(req, reply);
    if (!viewer) return reply;
    const p = req.principal;
    const id = threadIdOf(req.params.id);
    const found = id === undefined ? undefined : getCard(db, id);
    // A card of another session's own thread is as unknown as its thread.
    const card = found && getThread(db, found.threadId, viewer) ? found : undefined;
    if (!card || !p) return reply.code(404).send({ error: 'unknown card' });
    const cfg = req.jmConfig ?? config();
    const secrets = redactionList(cfg.secrets);
    if (card.kind === 'setting') {
      if (!cardUndoable(card)) {
        const error =
          card.state === 'undone' ? 'this card is already undone' : 'this card has no Undo';
        return reply.code(409).send({ error });
      }
      if (!deps.store)
        return reply.code(503).send({ error: 'this server has no config store to undo through' });
      const ctx: ActionCtx = { db, now: deps.now, config: cfg, principal: p, secrets };
      const r = undoSettingCard(ctx, deps.store, card);
      if (!r.ok)
        return reply.code(r.status).send({ ...(r.body ?? {}), error: redact(r.error, secrets) });
      const undone = getCard(db, card.id) ?? card;
      deps.turns?.publishCard?.(undone);
      return { card: publicCard(undone) };
    }
    const zone = cfg.dropZones.find((z) => z.id === card.zoneId);
    if (!cardUndoable(card) || !zone) {
      const error =
        card.state === 'undone' ? 'this card is already undone' : 'this card has no Undo';
      return reply.code(409).send({ error });
    }
    if (!deps.forgesFor)
      return reply.code(503).send({ error: 'this server has no forge to undo through' });
    const r = await undoCard(db, deps.forgesFor(zone.id), card, p, deps.now(), {
      zoneMode: zone.mode,
      secrets,
    });
    if (!r.ok) return reply.code(r.status).send({ error: redact(r.error, secrets) });
    const undone = getCard(db, card.id) ?? card;
    deps.turns?.publishCard?.(undone);
    return { card: publicCard(undone) };
  });

  /**
   * The thread's stream (server-sent events): its stored messages after the last seq the browser
   * saw, then the running turn's events, then `done` once no turn of the thread waits or runs.
   * Reopening the thread replays what it missed.
   */
  app.get<{ Params: { id: string } }>('/api/chat/threads/:id/events', async (req, reply) => {
    const viewer = sessionOf(req, reply);
    if (!viewer) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id, viewer);
    if (!thread) return reply.code(404).send({ error: 'unknown thread' });
    let last = afterSeqOf(req);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    let ended = false;
    let replaying = true;
    let unsubscribe: (() => void) | undefined;
    const beat = setInterval(() => raw.write(': keep\n\n'), HEARTBEAT_MS);
    beat.unref();
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(beat);
      unsubscribe?.();
      raw.end();
    };
    const send = (event: ChatSseEvent, seq: number, data: unknown): void => {
      if (ended) return;
      last = Math.max(last, seq);
      raw.write(`event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const settle = (): void => {
      if (ended || threadBusy(db, thread.id)) return;
      send('done', last, { seq: last });
      end();
    };
    const relay = (e: HubEvent): void => {
      const ev = e.event;
      if (ev.type === 'message') {
        const m = ev.message;
        if (m.role === 'tool') {
          // A step's tool, input and result when stored (#502), or the date its result was
          // pruned (#515, #587); a later update has the same seq.
          const { toolName, input, result, resultPrunedAt } = m;
          send('tool', m.seq, {
            seq: m.seq,
            text: m.text,
            createdAt: m.createdAt,
            ...(toolName === undefined ? {} : { toolName }),
            ...(input === undefined ? {} : { input }),
            ...(result === undefined ? {} : { result }),
            ...(resultPrunedAt === undefined ? {} : { resultPrunedAt }),
          });
        } else if (m.role === 'owner') send('message', m.seq, publicMessage(m));
        // The same HTML the stored page shows (#490): the browser sets only this as markup.
        else send('message', m.seq, { ...publicMessage(m), html: messageTextHtml(m) });
        if (!replaying) settle();
      } else if (ev.type === 'text') {
        send('text', e.seq, { seq: e.seq, text: ev.text });
      } else if (ev.type === 'card') {
        send('card', e.seq, { seq: e.seq, card: publicCard(ev.card) });
      }
    };
    req.raw.on('close', end);

    // The results stored since the browser saw their steps (#583), each under its step's seq.
    for (const message of resultStepsUpTo(db, thread.id, last)) {
      relay({ seq: message.seq, event: { type: 'message', message } });
    }
    const { turns } = deps;
    if (turns?.subscribe) {
      unsubscribe = turns.subscribe(thread.id, last, relay);
      replaying = false;
      if (ended) unsubscribe();
      settle();
    } else {
      // No turn runner: nothing changes while the browser waits, so the replay is all there is.
      for (const message of listMessages(db, thread.id, last)) {
        relay({ seq: message.seq, event: { type: 'message', message } });
      }
      send('done', last, { seq: last });
      end();
    }
    return reply;
  });
}
