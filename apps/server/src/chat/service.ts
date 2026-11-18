import { type ChatEvent, ChatEventSchema, type ChatTurnRequest } from '@jumpmaster/protocol';

/** How the server reaches the `chat` compose service. */
export interface ChatServiceClient {
  /** Runs one turn and yields its events; throws when the service can't be reached or stops. */
  runTurn(req: ChatTurnRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** The service's own health, or null when it doesn't answer. */
  health(): Promise<{ ok: boolean; claude: boolean; forge: boolean } | null>;
}

const HEALTH_TIMEOUT_MS = 5_000;
/** The longest NDJSON line the server reads before it drops the stream as broken. */
const MAX_LINE_CHARS = 1_000_000;

/** Each valid event on one NDJSON line; a line that isn't JSON or isn't an event is dropped. */
function eventOf(line: string): ChatEvent | undefined {
  if (line.trim() === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = ChatEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The chat service over HTTP: `POST /turns` answers NDJSON, one `ChatEvent` per line, and
 * `GET /healthz` its probes. Errors name the status only, never the request (which holds tokens).
 */
export function httpChatService(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): ChatServiceClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async *runTurn(req, signal) {
      const res = await fetchImpl(`${base}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`the chat service answered HTTP ${res.status}`);
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const e = eventOf(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (e) yield e;
          nl = buf.indexOf('\n');
        }
        if (buf.length > MAX_LINE_CHARS) throw new Error('the chat service sent an over-long line');
      }
      buf += decoder.decode();
      const last = eventOf(buf);
      if (last) yield last;
    },
    async health() {
      try {
        const res = await fetchImpl(`${base}/healthz`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as Record<string, unknown>;
        return {
          ok: body.ok === true,
          claude: body.claude === true,
          forge: body.forge === true,
        };
      } catch {
        return null;
      }
    },
  };
}
