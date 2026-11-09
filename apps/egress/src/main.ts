// The egress proxy's entry point. Prints `{"ready":true}` once listening; the stick waits for that
// line before it creates the trooper, and fails the drop without it. Every tunnel (or refusal) is
// one JSON line on stdout, which the stick aggregates into the drop's egress events.
import { configFromEnv } from './config.js';
import { startProxy } from './proxy.js';

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const proxy = await startProxy({
    ...config,
    log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  });
  const stop = () => {
    // Closing ends every tunnel, which logs it, so the stick sees the drop's last connections.
    void proxy.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
