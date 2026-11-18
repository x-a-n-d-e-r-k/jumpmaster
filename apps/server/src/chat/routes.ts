import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LiveConfig } from '../config/source.js';
import type { Db } from '../db/open.js';
import { appendMessage, createThread, getThread, listMessages, listThreads } from './store.js';

/** The longest owner message, in characters. */
export const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_TITLE = 'New chat';

export interface ChatRouteDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  /** Starts the thread's next queued turn (Task 7); absent, messages wait as `queued`. */
  turns?: { enqueue(threadId: number): void };
}

const NewThreadBody = z.object({ title: z.string().trim().min(1).max(200).optional() });
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

function threadIdOf(raw: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { db } = deps;

  app.get('/api/chat/threads', async (req, reply) => {
    if (!sessionOf(req, reply)) return reply;
    return { threads: listThreads(db) };
  });

  app.post('/api/chat/threads', async (req, reply) => {
    if (!sessionOf(req, reply)) return reply;
    const body = NewThreadBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'a title is 1 to 200 characters' });
    return { thread: createThread(db, { title: body.data.title ?? DEFAULT_TITLE }, deps.now()) };
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
}
