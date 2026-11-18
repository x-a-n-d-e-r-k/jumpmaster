// The `chat` compose service's entry point (`node /opt/trooper/chat/main.js` on the trooper image).
// It holds no secrets at rest: each turn brings its Claude token and MCP token in the request.
import type { ChatEvent, ChatTurnRequest } from '@jumpmaster/protocol';
import { DEFAULT_CHAT_LISTEN, startChatServer } from './server.js';

/** Until the turn runner lands, every turn answers that it is not installed. */
async function* notInstalled(
  _req: ChatTurnRequest,
  _signal: AbortSignal,
): AsyncIterable<ChatEvent> {
  yield { type: 'error', code: 'claude_failed', message: 'turn runner not installed' };
}

const listen = (process.env.JM_CHAT_LISTEN ?? '').trim() || DEFAULT_CHAT_LISTEN;
const server = await startChatServer({ listen, runTurn: notInstalled });
process.stderr.write(`[chat] listening on ${listen} (port ${server.port})\n`);

for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => {
    void server.close().then(() => process.exit(0));
  });
