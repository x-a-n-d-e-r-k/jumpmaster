// The `chat` compose service's entry point (`node /opt/trooper/chat/main.js` on the trooper image).
// It holds no secrets at rest: each turn brings its Claude token and MCP token in the request.
import { DEFAULT_CHAT_LISTEN, startChatServer } from './server.js';
import { runChatTurn } from './turn.js';

const listen = (process.env.JM_CHAT_LISTEN ?? '').trim() || DEFAULT_CHAT_LISTEN;
const server = await startChatServer({
  listen,
  runTurn: (req, signal) => runChatTurn(req, signal),
});
process.stderr.write(`[chat] listening on ${listen} (port ${server.port})\n`);

for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => {
    void server.close().then(() => process.exit(0));
  });
