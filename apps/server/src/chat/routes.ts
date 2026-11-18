import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { configReader, type LiveConfig } from '../config/source.js';
import type { Db } from '../db/open.js';
import { focusKnown, focusTitle } from './focus.js';
import {
  appendMessage,
  type ChatMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  threadBusy,
} from './store.js';
import type { HubEvent } from './turns.js';

/** The longest owner message, in characters. */
export const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_TITLE = 'New chat';

export interface ChatRouteDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  /** Starts the thread's next queued turn (Task 7); absent, messages wait as `queued`. */
  turns?: ChatTurnHub;
}

/** What the routes need of the turn runner (`ChatTurns`). */
export interface ChatTurnHub {
  enqueue(threadId: number): void;
  /** Absent, the events route replays the stored messages only. */
  subscribe?(threadId: number, afterSeq: number, fn: (e: HubEvent) => void): () => void;
}

/** The names of the events `GET /api/chat/threads/:id/events` sends; each carries `id: <seq>`. */
export const CHAT_SSE_EVENTS = ['message', 'text', 'tool', 'card', 'done'] as const;
export type ChatSseEvent = (typeof CHAT_SSE_EVENTS)[number];

/** How often an open stream sends a comment, so proxies keep it open. */
const HEARTBEAT_MS = 25_000;

/** A message as the browser gets it: without the posting session's hash. */
const publicMessage = ({ sessionHash: _hash, ...m }: ChatMessage) => m;

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
  kind: z.enum(['zone', 'goals', 'briefing']),
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
    if (!sessionOf(req, reply)) return reply;
    return { threads: listThreads(db) };
  });

  app.post('/api/chat/threads', async (req, reply) => {
    if (!sessionOf(req, reply)) return reply;
    const body = NewThreadBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'a title is 1 to 200 characters, and a focus a zone, goals or briefing' });
    }
    const { focus } = body.data;
    if (focus && !focusKnown(db, config(), focus)) {
      return reply
        .code(404)
        .send({ error: `unknown ${focus.kind === 'briefing' ? 'briefing' : 'zone'}` });
    }
    const title = body.data.title ?? (focus ? focusTitle(db, config(), focus) : DEFAULT_TITLE);
    return { thread: createThread(db, { title, ...(focus ? { focus } : {}) }, deps.now()) };
  });

  app.get<{ Params: { id: string } }>('/api/chat/threads/:id', async (req, reply) => {
    if (!sessionOf(req, reply)) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id);
    if (!thread) return reply.code(404).send({ error: 'unknown thread' });
    return { thread, messages: listMessages(db, thread.id) };
  });

  app.post<{ Params: { id: string } }>('/api/chat/threads/:id/messages', async (req, reply) => {
    const sessionHash = sessionOf(req, reply);
    if (!sessionHash) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id);
    if (!thread) return reply.code(404).send({ error: 'unknown thread' });
    const body = MessageBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: `a message is 1 to ${MAX_MESSAGE_CHARS} characters of text` });
    }
    const message = appendMessage(
      db,
      thread.id,
      { role: 'owner', text: body.data.text, state: 'queued', sessionHash },
      deps.now(),
    );
    deps.turns?.enqueue(thread.id);
    return reply.code(202).send({ message });
  });

  /**
   * The thread's stream (server-sent events): its stored messages after the last seq the browser
   * saw, then the running turn's events, then `done` once no turn of the thread waits or runs.
   * Reopening the thread replays what it missed.
   */
  app.get<{ Params: { id: string } }>('/api/chat/threads/:id/events', async (req, reply) => {
    if (!sessionOf(req, reply)) return reply;
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(db, id);
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
          send('tool', m.seq, { seq: m.seq, text: m.text, createdAt: m.createdAt });
        } else send('message', m.seq, publicMessage(m));
        if (!replaying) settle();
      } else if (ev.type === 'text') {
        send('text', e.seq, { seq: e.seq, text: ev.text });
      }
    };
    req.raw.on('close', end);

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
