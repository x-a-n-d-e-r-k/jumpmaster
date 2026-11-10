import { describe, expect, test } from 'vitest';
import { ctlRequest, runCtl } from './ctl.js';

const TOKEN = 'o'.repeat(32);
const env = { JM_OPERATOR_TOKEN: TOKEN };

/** A fetch that records each call and answers `status` with `body`. */
function fakeFetch(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, impl };
}

async function run(args: string[], stdin = '', fetchImpl = fakeFetch()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCtl(
    args,
    env,
    fetchImpl.impl,
    (l) => out.push(l),
    (l) => err.push(l),
    async () => stdin,
  );
  return { code, out, err, calls: fetchImpl.calls };
}

describe('ctl setup and passphrase verbs', () => {
  test('the setup and passphrase verbs map to their routes; a passphrase in argv is refused', () => {
    expect(ctlRequest(['setup-code'])).toEqual({ path: '/api/control/setup/code', body: {} });
    expect(ctlRequest(['setup', 'reopen'])).toEqual({
      path: '/api/control/setup/reopen',
      body: {},
    });
    expect(ctlRequest(['passphrase', 'set'])).toEqual({
      path: '/api/control/passphrase',
      method: 'PUT',
      body: {},
    });
    expect(ctlRequest(['passphrase', 'set', 'hunter2hunter2'])).toBeNull();
    expect(ctlRequest(['setup'])).toBeNull();
    expect(ctlRequest(['setup-code', 'extra'])).toBeNull();
    expect(ctlRequest(['passphrase'])).toBeNull();
  });

  test('ctl passphrase set reads stdin, claims or replaces the operator with no browser, ends setup mode and deletes every session', async () => {
    const pass = 'a long operator passphrase';
    const f = fakeFetch(200, { operator: 'claimed', sessionsDeleted: 0 });
    const r = await run(['passphrase', 'set'], `${pass}\r\n`, f);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe('http://127.0.0.1:7420/api/control/passphrase');
    expect(call.init.method).toBe('PUT');
    expect(JSON.parse(String(call.init.body))).toEqual({ passphrase: pass });
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.out.join('\n')).toContain('claimed');
    expect(`${r.out.join('\n')}${r.err.join('\n')}`).not.toContain(pass);
    expect(call.url).not.toContain(pass);
  });

  test('ctl passphrase set with nothing on stdin calls nothing', async () => {
    const r = await run(['passphrase', 'set'], '\n');
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(r.err.join('\n')).toMatch(/stdin/);
  });

  test('ctl setup-code asks the server to print a fresh code and says where to read it', async () => {
    const r = await run(
      ['setup-code'],
      '',
      fakeFetch(200, { printed: true, next: "the new setup code is on the server's output" }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/setup/code');
    expect(r.calls[0]?.init.method).toBe('POST');
    expect(r.out.join('\n')).toContain("server's output");
  });

  test('ctl setup reopen posts to the reopen route', async () => {
    const r = await run(['setup', 'reopen']);
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/setup/reopen');
  });

  test('the usage line names the new verbs', async () => {
    const r = await run(['nope']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/setup-code/);
    expect(r.err.join('\n')).toMatch(/setup reopen/);
    expect(r.err.join('\n')).toMatch(/passphrase set/);
  });
});
