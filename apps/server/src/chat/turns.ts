import { randomUUID } from 'node:crypto';
import {
  CHAT_PROTOCOL,
  type ChatErrorCode,
  type ChatEvent,
  type ChatTurnRequest,
  type ChatZoneFetch,
  redact,
  withBasicAuth,
} from '@jumpmaster/protocol';
import { configReader, type LiveConfig } from '../config/source.js';
import { type Config, chatConfigOf } from '../config.js';
import type { Db } from '../db/open.js';
import { getDropZoneDefaultBranch } from '../db/repo.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { mintChatToken, revokeMcpToken } from '../mcp/tokens.js';
import { fence, neutralise } from '../payloads.js';
import { redactionList } from '../scrub.js';
import {
  dispatchGate,
  ingestRateLimit,
  type RateLimitSource,
  rateLimitFromEvent,
} from '../usage.js';
import type { ResolvedApps } from '../vault/resolution.js';
import type { ChatCard } from './cards.js';
import { type ChatReadCredential, chatReadCredential } from './credentials.js';
import { focusContext } from './focus.js';
import type { ChatServiceClient } from './service.js';
import {
  appendMessage,
  type ChatMessage,
  getThread,
  listMessages,
  nextQueued,
  setMessage,
  setThreadSession,
} from './store.js';

/**
 * The server's chat turn runner (#336, Task 7). An owner message waits as `queued` until its
 * thread's turn before it has ended (one turn per thread), and turns across threads run up to
 * `chat.maxConcurrentTurns` at once. Each turn:
 * - is refused while the usage gate is `stopped` or `closed`, before anything is minted or sent;
 * - mints a chat MCP token living `chat.turnMinutes`, revoked when the turn ends, however it ends;
 * - takes a read credential per zone (R3), released when the turn ends;
 * - stores what the service streams after `redact` over the server's secrets plus the turn's own
 *   tokens, so no stored message, hub event or log line carries one.
 */

/** A thread's live stream: stored messages as they change, and the service's events as they come. */
export type HubEvent = {
  seq: number;
  event: ChatEvent | { type: 'message'; message: ChatMessage } | { type: 'card'; card: ChatCard };
};

export interface ChatTurnDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  service: ChatServiceClient;
  /** The chat MCP endpoint as the chat service reaches it (`chatMcpUrl`). */
  mcpUrl: string;
  resolvedApps(): ResolvedApps;
  appTokens?: Pick<AppTokenSource, 'fresh'>;
  /** The operator's log; every line is redacted before it gets here. */
  log(msg: string): void;
  /** Jitter for a usage pause (`ingestRateLimit`); `Math.random` by default. */
  rand?: () => number;
}

/**
 * Where a chat turn's rate-limit observation came from (R11). The id's `chat:` prefix never
 * matches a drop id, so the usage state never treats a chat turn as a drop, a probe or a cause
 * work item, and usage-credit use in a chat never starts a credits stop by itself.
 *
 * Because no drop has this id, `ingestRateLimit` finds no drop to read a model from, so a
 * per-model window a chat turn reports is recorded with a null model. That is intended: the
 * chat runs no drop, and the window's utilization still counts for the install.
 */
export function chatRateLimitSource(
  threadId: number,
  seq: number,
  startedAt: string,
): RateLimitSource {
  return { dropId: `chat:${threadId}:${seq}`, workItemId: null, startedAt, outcome: null };
}

/** Why a turn is refused under the usage gate, in plain words. */
export const GATE_REFUSAL: Record<'stopped' | 'closed', string> = {
  stopped:
    'Claude use is stopped so the install does not pay for extra usage credits, so the chat cannot answer until that stop ends.',
  closed:
    'Claude is refusing requests right now because a usage limit was reached, so the chat cannot answer until the limit resets.',
};

/** The failure of a turn whose stream broke or ended with no result. */
export const SERVICE_STOPPED = 'The chat service stopped answering';

const ERROR_WORDS: Record<Exclude<ChatErrorCode, 'deadline'>, string> = {
  session_lost: 'The chat lost its place in this thread. Send the message again.',
  claude_failed: 'Claude could not answer this message.',
  fetch_failed: 'The chat service could not fetch the code it needed.',
  bad_request: 'The chat service refused this turn.',
  busy: 'The chat service was already running this turn.',
};
const deadlineWords = (minutes: number): string =>
  `This turn ran longer than ${minutes} minutes and was stopped.`;
const CLAUDE_UNFINISHED = 'Claude could not finish this answer.';
const NOT_STARTED = 'The chat could not start this turn.';
const NO_SESSION = 'This message has no browser session to act for.';
const NO_CLAUDE = 'Claude is not set up yet: add the Claude token in Settings.';
const NO_READ_CREDENTIAL = 'no read credential for this zone';

/** The most model turns one chat turn may take. */
export const CHAT_MAX_TURNS = 50;
/** How many of a thread's latest messages the server-written summary carries. */
export const HISTORY_MESSAGES = 20;
/** The longest server-written summary, fence included. */
export const HISTORY_MAX_CHARS = 24_000;
/** How long past the turn's deadline the server waits for the service before it gives up. */
const DEADLINE_GRACE_MS = 30_000;

/** The chat MCP endpoint as the chat service reaches it on the compose network. */
export const chatMcpUrl = (port: number): string => `http://jumpmaster:${port}/mcp/chat`;

/** What a confirm path in assistant text becomes: the pending card carries the action. */
export const CONFIRM_PATH_WORDS = 'the card below';

// An optional origin, then `/config/confirm/<id>`. The id is a session-bound capability (#508).
const CONFIRM_URL = String.raw`(?:https?:\/\/[^\s/<>()\[\]\x60]+)?\/config\/confirm\/[A-Za-z0-9_-]+`;
const CONFIRM_PATH = new RegExp(
  [
    // A Markdown link, with an optional <target> and title: the whole link collapses.
    String.raw`\[[^\]\n]*\]\(\s*<?${CONFIRM_URL}>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`,
    // Backticked, or an autolink.
    String.raw`\x60+\s*${CONFIRM_URL}\s*\x60+`,
    String.raw`<${CONFIRM_URL}>`,
    CONFIRM_URL,
  ].join('|'),
  'g',
);

/**
 * Replaces each `/config/confirm/<id>` in assistant text, with or without an origin, in
 * backticks or as a Markdown link, by plain words: the id belongs on the card, not in prose.
 */
export function stripConfirmPaths(s: string): string {
  return s.replace(CONFIRM_PATH, CONFIRM_PATH_WORDS);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The thread's history before `beforeSeq`, for a turn whose Claude session was lost: its last 20
 * messages, fenced as data, the newest kept when they don't all fit in 24 000 characters.
 */
/**
 * Whether `msg` opens its thread's conversation: no owner message before it was answered. Only
 * this turn is given the focused object's context, so it is given once.
 */
function firstTurn(db: Db, threadId: number, msg: ChatMessage): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM chat_messages WHERE thread_id = ? AND seq < ? AND role = 'owner'
           AND state = 'done' LIMIT 1`,
      )
      .get(threadId, msg.seq) === undefined
  );
}

export function historySummary(
  db: Db,
  threadId: number,
  beforeSeq: number,
  fenceId: string,
): string {
  const lines = listMessages(db, threadId)
    .filter((m) => m.seq < beforeSeq)
    .slice(-HISTORY_MESSAGES)
    .map(
      (m) =>
        `[${m.role}] ${neutralise(m.role === 'assistant' ? stripConfirmPaths(m.text) : m.text)}`,
    );
  const room = HISTORY_MAX_CHARS - fence(fenceId, 'history', '').length;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const add = line.length + (kept.length > 0 ? 2 : 0);
    if (used + add > room) {
      // The newest message alone is too long: keep its end.
      if (kept.length === 0) kept.push(line.slice(-room));
      break;
    }
    kept.unshift(line);
    used += add;
  }
  return fence(fenceId, 'history', kept.join('\n\n'));
}

/** The zone list as trusted lines: what the install is, and whether each zone's code is there. */
function systemPromptOf(zones: ChatZoneFetch[]): string {
  const lines = zones.map(
    (z) =>
      `(trusted) zone ${z.id}: repository ${z.owner}/${z.name}, default branch ${z.defaultBranch}, ` +
      (z.token === null
        ? `code unavailable (${NO_READ_CREDENTIAL}); say so when asked about its code`
        : 'code fetched for this turn'),
  );
  return [
    "The install's zones, from the server's configuration (trusted). Call the MCP tools with one of these zone ids.",
    ...lines,
  ].join('\n');
}

type Attempt =
  | { kind: 'done'; texts: string[]; usage?: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'session_lost' };

export class ChatTurns {
  private readonly d: ChatTurnDeps;
  private readonly config: () => Config;
  /** Threads with a drain loop running: their next message waits for it. */
  private readonly draining = new Set<number>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly hubs = new Map<number, Set<(e: HubEvent) => void>>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(d: ChatTurnDeps) {
    this.d = d;
    this.config = configReader(d.config);
  }

  /** Runs the thread's queued messages in order, after any turn of the thread still running. */
  enqueue(threadId: number): void {
    // A running drain re-reads the queue after each turn, so it picks this message up.
    if (this.draining.has(threadId)) return;
    this.draining.add(threadId);
    const task: Promise<void> = this.drain(threadId)
      .catch((e: unknown) => this.log(`chat thread ${threadId} stopped: ${errorText(e)}`, []))
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }

  /**
   * Sends `fn` the thread's stored messages after `afterSeq`, then its live events until the
   * returned function is called.
   */
  subscribe(threadId: number, afterSeq: number, fn: (e: HubEvent) => void): () => void {
    for (const message of listMessages(this.d.db, threadId, afterSeq)) {
      fn({ seq: message.seq, event: { type: 'message', message } });
    }
    let set = this.hubs.get(threadId);
    if (!set) {
      set = new Set();
      this.hubs.set(threadId, set);
    }
    set.add(fn);
    return () => {
      const s = this.hubs.get(threadId);
      s?.delete(fn);
      if (s?.size === 0) this.hubs.delete(threadId);
    };
  }

  /**
   * Sends a chat action's card, as recorded, to its thread's subscribers. Its seq is the thread's
   * latest, so a browser's `Last-Event-ID` never goes back; a reopened page renders stored cards.
   */
  publishCard(card: ChatCard): void {
    const { seq } = this.d.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_messages WHERE thread_id = ?')
      .get(card.threadId) as { seq: number };
    this.emit(card.threadId, { seq, event: { type: 'card', card } });
  }

  /** Resolves once no turn is running or waiting. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  private emit(threadId: number, e: HubEvent): void {
    for (const fn of this.hubs.get(threadId) ?? []) {
      try {
        fn(e);
      } catch {
        // A broken subscriber never stops the turn.
      }
    }
  }

  private log(msg: string, turnSecrets: readonly string[]): void {
    this.d.log(redact(msg, [...redactionList(this.config().secrets), ...turnSecrets]));
  }

  private cap(): number {
    return chatConfigOf(this.config()).maxConcurrentTurns;
  }

  /** Waits for a turn slot; the returned function gives it back. */
  private async slot(): Promise<() => void> {
    if (this.waiters.length === 0 && this.active < this.cap()) this.active++;
    // The releaser counts the slot for us before it wakes us.
    else await new Promise<void>((r) => this.waiters.push(r));
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.active--;
      while (this.waiters.length > 0 && this.active < this.cap()) {
        this.active++;
        this.waiters.shift()?.();
      }
    };
  }

  private async drain(threadId: number): Promise<void> {
    try {
      while (nextQueued(this.d.db, threadId)) {
        const release = await this.slot();
        try {
          const msg = nextQueued(this.d.db, threadId);
          if (!msg) return;
          await this.turn(threadId, msg);
        } finally {
          release();
        }
      }
    } finally {
      this.draining.delete(threadId);
    }
  }

  /** Stores a change to a message and sends the stored row to the thread's subscribers. */
  private store(threadId: number, msg: ChatMessage, patch: Parameters<typeof setMessage>[2]): void {
    setMessage(this.d.db, msg.id, patch, this.d.now());
    const row = listMessages(this.d.db, threadId, msg.seq - 1)[0];
    if (row) this.emit(threadId, { seq: row.seq, event: { type: 'message', message: row } });
  }

  private append(threadId: number, m: Parameters<typeof appendMessage>[2]): ChatMessage {
    const row = appendMessage(this.d.db, threadId, m, this.d.now());
    this.emit(threadId, { seq: row.seq, event: { type: 'message', message: row } });
    return row;
  }

  private async turn(threadId: number, msg: ChatMessage): Promise<void> {
    const { db } = this.d;
    const config = this.config();
    const gate = dispatchGate(db, config.usage, this.d.now());
    if (gate === 'stopped' || gate === 'closed') {
      this.store(threadId, msg, { state: 'failed', error: GATE_REFUSAL[gate] });
      return;
    }
    const thread = getThread(db, threadId);
    // Never left queued: the drain loop would pick it up again.
    if (!thread) {
      this.store(threadId, msg, { state: 'failed', error: NOT_STARTED });
      return;
    }
    if (!msg.sessionHash) {
      this.store(threadId, msg, { state: 'failed', error: NO_SESSION });
      return;
    }
    const claudeToken = config.secrets.claudeToken;
    if (!claudeToken) {
      this.store(threadId, msg, { state: 'failed', error: NO_CLAUDE });
      return;
    }
    const chat = chatConfigOf(config);
    const startedAt = this.d.now().toISOString();
    this.store(threadId, msg, { state: 'running' });

    // Every value this turn must never store, emit or log, beyond the server's own list.
    const turnSecrets: string[] = [claudeToken];
    const clean = (s: string): string =>
      redact(s, [...redactionList(config.secrets), ...turnSecrets]);
    // Assistant text, stored and streamed alike: redacted, and with no confirm path (#508).
    const cleanText = (s: string): string => stripConfirmPaths(clean(s));
    const creds: ChatReadCredential[] = [];
    let tokenId: number | undefined;
    try {
      const minted = mintChatToken(
        db,
        { threadId, messageId: msg.id, sessionHash: msg.sessionHash, minutes: chat.turnMinutes },
        this.d.now(),
      );
      tokenId = minted.id;
      turnSecrets.push(minted.token);

      const turnId = randomUUID();
      // A focused thread: the object's context (fenced with this turn's id) and the refs it names.
      const focus =
        thread.focusKind && thread.focusZoneId && thread.focusRef
          ? focusContext(
              db,
              config,
              { kind: thread.focusKind, zoneId: thread.focusZoneId, ref: thread.focusRef },
              turnId,
            )
          : undefined;
      const context =
        focus && firstTurn(db, threadId, msg)
          ? `${focus.text}\n\nAbove is what the owner opened this thread from, as the server recorded it. The owner's message:\n\n`
          : '';

      const zones: ChatZoneFetch[] = [];
      for (const zone of config.dropZones) {
        const cred = await chatReadCredential(
          zone,
          config,
          this.d.resolvedApps(),
          this.d.appTokens,
        );
        if (cred) {
          creds.push(cred);
          turnSecrets.push(...withBasicAuth(cred.token));
        }
        const [owner = '', name = ''] = zone.repo.split('/');
        zones.push({
          id: zone.id,
          owner,
          name,
          defaultBranch: getDropZoneDefaultBranch(db, zone.id) ?? 'main',
          token: cred?.token ?? null,
          extraRefs: focus?.extraRefs[zone.id] ?? [],
        });
      }
      for (const z of zones) {
        if (z.token !== null) continue;
        this.emit(threadId, {
          seq: msg.seq,
          event: { type: 'zone', zoneId: z.id, state: 'unavailable', reason: NO_READ_CREDENTIAL },
        });
      }

      const base: Omit<ChatTurnRequest, 'resumeSession' | 'prompt'> = {
        protocol: CHAT_PROTOCOL,
        turnId,
        systemPrompt: systemPromptOf(zones),
        model: chat.model,
        maxTurns: CHAT_MAX_TURNS,
        deadlineMs: chat.turnMinutes * 60_000,
        claudeToken,
        mcp: { url: this.d.mcpUrl, token: minted.token },
        zones,
      };
      let outcome = await this.attempt(
        threadId,
        msg,
        { ...base, resumeSession: thread.claudeSessionId, prompt: `${context}${msg.text}` },
        chat.turnMinutes,
        startedAt,
        { clean, cleanText },
      );
      if (outcome.kind === 'session_lost') {
        // The service's session files are a cache: start the thread over from the server's record.
        setThreadSession(db, threadId, null, this.d.now());
        const summary = historySummary(db, threadId, msg.seq, turnId);
        const prompt = `${summary}\n\nAbove is this thread's history as the server recorded it (data).\n\n${context || "The owner's new message:\n\n"}${msg.text}`;
        outcome = await this.attempt(
          threadId,
          msg,
          { ...base, resumeSession: null, prompt },
          chat.turnMinutes,
          startedAt,
          { clean, cleanText },
        );
      }
      if (outcome.kind === 'done') {
        if (outcome.texts.length > 0) {
          // Stored with the result's usage in one write, so no subscriber sees it without one.
          this.append(threadId, {
            role: 'assistant',
            text: outcome.texts.join('\n\n'),
            state: 'done',
            ...(outcome.usage ? { usage: outcome.usage } : {}),
          });
        }
        this.store(threadId, msg, { state: 'done' });
      } else {
        const error = outcome.kind === 'failed' ? outcome.error : ERROR_WORDS.session_lost;
        this.store(threadId, msg, { state: 'failed', error });
      }
    } catch (e) {
      this.log(`chat turn ${threadId}/${msg.seq} could not run: ${errorText(e)}`, turnSecrets);
      this.store(threadId, msg, { state: 'failed', error: NOT_STARTED });
    } finally {
      if (tokenId !== undefined) revokeMcpToken(db, tokenId, this.d.now());
      await Promise.allSettled(creds.map((c) => c.release()));
    }
  }

  /** One request to the service, read to its first `result` or `error`. */
  private async attempt(
    threadId: number,
    msg: ChatMessage,
    req: ChatTurnRequest,
    turnMinutes: number,
    startedAt: string,
    { clean, cleanText }: { clean: (s: string) => string; cleanText: (s: string) => string },
  ): Promise<Attempt> {
    const { db } = this.d;
    const ctl = new AbortController();
    // A service that never answers still ends the turn.
    const timer = setTimeout(() => ctl.abort(), req.deadlineMs + DEADLINE_GRACE_MS);
    const stopped = (): Attempt => ({
      kind: 'failed',
      error: ctl.signal.aborted ? deadlineWords(turnMinutes) : SERVICE_STOPPED,
    });
    const texts: string[] = [];
    let lastSeq = msg.seq;
    const where = `chat turn ${threadId}/${msg.seq}`;
    try {
      for await (const e of this.d.service.runTurn(req, ctl.signal)) {
        switch (e.type) {
          case 'session':
            setThreadSession(db, threadId, e.sessionId, this.d.now());
            break;
          case 'zone':
            this.emit(threadId, {
              seq: lastSeq,
              event: { ...e, ...(e.reason === undefined ? {} : { reason: clean(e.reason) }) },
            });
            break;
          case 'text': {
            const text = cleanText(e.text);
            texts.push(text);
            this.emit(threadId, { seq: lastSeq, event: { type: 'text', text } });
            break;
          }
          case 'tool': {
            const row = this.append(threadId, {
              role: 'tool',
              text: clean(e.summary),
              state: 'done',
            });
            lastSeq = row.seq;
            break;
          }
          case 'rate_limit': {
            // The chat uses the install's one Claude credential: its limits are the install's.
            const data = rateLimitFromEvent(e.data);
            if (!data) break;
            try {
              ingestRateLimit(
                db,
                data,
                chatRateLimitSource(threadId, msg.seq, startedAt),
                this.config().usage,
                this.d.now(),
                this.d.rand ?? Math.random,
              );
            } catch (err) {
              // Usage accounting never breaks the owner's turn.
              this.d.log(clean(`${where}: usage not recorded: ${errorText(err)}`));
            }
            break;
          }
          case 'result':
            if (e.sessionId) setThreadSession(db, threadId, e.sessionId, this.d.now());
            if (e.isError) return { kind: 'failed', error: CLAUDE_UNFINISHED };
            return { kind: 'done', texts, ...(e.usage ? { usage: e.usage } : {}) };
          case 'error':
            if (e.code === 'session_lost') return { kind: 'session_lost' };
            this.d.log(clean(`${where} ended: ${e.code}: ${e.message}`));
            return {
              kind: 'failed',
              error: e.code === 'deadline' ? deadlineWords(turnMinutes) : ERROR_WORDS[e.code],
            };
        }
      }
      this.d.log(`${where}: the chat service ended the stream with no result`);
      return stopped();
    } catch (e) {
      this.d.log(clean(`${where}: the chat service stream broke: ${errorText(e)}`));
      return stopped();
    } finally {
      clearTimeout(timer);
    }
  }
}
