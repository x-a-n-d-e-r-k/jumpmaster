import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatEvent, ChatTurnRequest } from '@jumpmaster/protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { httpChatService } from './service.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const req = { protocol: 1 } as unknown as ChatTurnRequest;

describe('httpChatService', () => {
  test.each(['http://h:1', 'http://h:1/', 'http://h:1///'])(
    'base URL %j posts to http://h:1/turns',
    async (baseUrl) => {
      const seen: string[] = [];
      const fakeFetch = (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response('{"type":"result","isError":false}\n', { status: 200 });
      }) as typeof globalThis.fetch;
      for await (const _ of httpChatService(baseUrl, fakeFetch).runTurn(
        req,
        new AbortController().signal,
      )) {
        // drain
      }
      expect(seen).toEqual(['http://h:1/turns']);
    },
  );

  test('it reads NDJSON and drops lines that are not valid events', async () => {
    let body = '';
    const base = await serve((r, res) => {
      r.on('data', (c: Buffer) => {
        body += c.toString();
      });
      r.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"type":"text","te');
        res.write('xt":"one"}\nnot json\n{"type":"nope"}\n');
        res.end('{"type":"result","isError":false}');
      });
    });
    const events: ChatEvent[] = [];
    for await (const e of httpChatService(base).runTurn(req, new AbortController().signal)) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: 'text', text: 'one' },
      { type: 'result', isError: false },
    ]);
    expect(JSON.parse(body)).toEqual({ protocol: 1 });
  });

  test('a non-2xx answer throws, naming the status only', async () => {
    const base = await serve((_r, res) => {
      res.writeHead(503);
      res.end('down');
    });
    const run = async () => {
      for await (const _ of httpChatService(base).runTurn(req, new AbortController().signal)) {
        // nothing
      }
    };
    await expect(run()).rejects.toThrow('HTTP 503');
  });

  test('health answers the probes, or null when the service does not answer', async () => {
    const base = await serve((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, claude: true, forge: false }));
    });
    expect(await httpChatService(base).health()).toEqual({ ok: true, claude: true, forge: false });
    expect(await httpChatService('http://127.0.0.1:1').health()).toBeNull();
  });
});
