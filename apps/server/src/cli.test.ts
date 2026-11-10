import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runCli } from './cli.js';
import { runCtl } from './ctl.js';

const OPERATOR = 'o'.repeat(40);

function tokenFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jm-ctl-')), 'operator');
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function deps() {
  return {
    serve: vi.fn(async (_config: string | undefined) => 0),
    ctl: vi.fn(async (_args: string[]) => 0),
    init: vi.fn(async (_args: string[]) => 0),
    err: vi.fn((_line: string) => undefined),
  };
}

describe('jumpmaster command', () => {
  test('serve <config> starts the server; a bare config path is the default command', async () => {
    const d = deps();
    expect(await runCli(['serve', '/config/jm.json'], d)).toBe(0);
    expect(await runCli(['/config/other.json'], d)).toBe(0);
    expect(d.serve.mock.calls).toEqual([['/config/jm.json'], ['/config/other.json']]);
    expect(d.ctl).not.toHaveBeenCalled();
  });

  test('ctl passes its arguments through; doctor is an alias of ctl doctor', async () => {
    const d = deps();
    d.ctl.mockResolvedValueOnce(1);
    expect(await runCli(['ctl', 'pause', 'main'], d)).toBe(1);
    expect(await runCli(['doctor', '--drop', 'main'], d)).toBe(0);
    expect(d.ctl.mock.calls).toEqual([[['pause', 'main']], [['doctor', '--drop', 'main']]]);
    expect(d.serve).not.toHaveBeenCalled();
  });

  test('serve without a path starts the server with none: JM_CONFIG or db mode decides', async () => {
    const d = deps();
    expect(await runCli(['serve'], d)).toBe(0);
    expect(d.serve.mock.calls).toEqual([[undefined]]);
  });

  test('no arguments, or serve with a command word, print usage and exit 2', async () => {
    const d = deps();
    expect(await runCli([], d)).toBe(2);
    expect(await runCli(['serve', 'init'], d)).toBe(2);
    expect(await runCli(['serve', 'a', 'b'], d)).toBe(2);
    expect(d.serve).not.toHaveBeenCalled();
    expect(d.init).not.toHaveBeenCalled();
    expect(d.err.mock.calls.flat().join('\n')).toMatch(/usage: jumpmaster/);
  });

  test('init passes its arguments through and returns its exit code', async () => {
    const d = deps();
    d.init.mockResolvedValueOnce(3);
    expect(await runCli(['init', '--repo', 'octo/demo'], d)).toBe(3);
    expect(d.init.mock.calls).toEqual([[['--repo', 'octo/demo']]]);
    expect(d.serve).not.toHaveBeenCalled();
  });
});

describe('ctl', () => {
  const ok = () =>
    vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response('{}', { status: 200 }));

  test('ctl reads the operator token from JM_OPERATOR_TOKEN_FILE', async () => {
    const fetchImpl = ok();
    const env = { JM_OPERATOR_TOKEN_FILE: tokenFile(`${OPERATOR}\n`) };
    expect(await runCtl(['pause', 'main'], env, fetchImpl, () => {})).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:7420/api/control/zones/main');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${OPERATOR}`);
  });

  test('ctl still reads JM_OPERATOR_TOKEN from the environment', async () => {
    const fetchImpl = ok();
    expect(await runCtl(['briefings'], { JM_OPERATOR_TOKEN: OPERATOR }, fetchImpl, () => {})).toBe(
      0,
    );
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${OPERATOR}`,
    );
  });

  test('a token set both ways, or not at all, exits 2 without a request or the value', async () => {
    const fetchImpl = ok();
    const err = vi.fn((_line: string) => undefined);
    const both = { JM_OPERATOR_TOKEN: OPERATOR, JM_OPERATOR_TOKEN_FILE: tokenFile(OPERATOR) };
    expect(await runCtl(['briefings'], both, fetchImpl, () => {}, err)).toBe(2);
    expect(await runCtl(['briefings'], {}, fetchImpl, () => {}, err)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    const said = err.mock.calls.flat().join('\n');
    expect(said).toMatch(/JM_OPERATOR_TOKEN and JM_OPERATOR_TOKEN_FILE/);
    expect(said).toMatch(/JM_OPERATOR_TOKEN or JM_OPERATOR_TOKEN_FILE is required/);
    expect(said).not.toContain(OPERATOR);
  });

  describe('ctl doctor', () => {
    const check = (status: string, id = `x.${status}`) => ({
      id,
      zoneId: status === 'pass' ? null : 'main',
      status,
      summary: `${id} summary`,
      ...(status === 'pass' ? {} : { fix: `${id} fix`, doc: 'docs/runbooks/install.md#x' }),
    });
    const answer = (checks: unknown[]) =>
      vi.fn(
        async (_url: URL | string, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              run: { id: 3, startedAt: 'a', finishedAt: 'b', checks, dropIds: [] },
            }),
            { status: 200 },
          ),
      );
    const env = { JM_OPERATOR_TOKEN: OPERATOR };

    test('ctl doctor exits 1 on a fail and 0 with only warns', async () => {
      const lines: string[] = [];
      const warnOnly = answer([check('pass'), check('warn'), check('skip')]);
      expect(await runCtl(['doctor'], env, warnOnly, (l) => lines.push(l))).toBe(0);
      const text = lines.join('\n');
      expect(text).toMatch(/PASS\s+x\.pass/);
      expect(text).toMatch(/WARN\s+main\s+x\.warn\s+x\.warn summary/);
      expect(text).toContain('fix: x.warn fix');
      expect(text).toContain('see: docs/runbooks/install.md#x');
      expect(text).toContain('1 pass, 1 warn, 0 fail, 1 skip');
      const [, init] = warnOnly.mock.calls[0] ?? [];
      expect(init?.method).toBe('POST');
      expect(await runCtl(['doctor', 'main'], env, answer([check('fail')]), () => {})).toBe(1);
    });

    test('--json prints the run as JSON, and a refused request exits 1', async () => {
      const lines: string[] = [];
      expect(
        await runCtl(['doctor', '--json'], env, answer([check('warn')]), (l) => lines.push(l)),
      ).toBe(0);
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ run: { id: 3 } });
      const busy = vi.fn(
        async () =>
          new Response('{"error":"a doctor run is already in progress"}', { status: 409 }),
      );
      const out: string[] = [];
      expect(await runCtl(['doctor'], env, busy, (l) => out.push(l))).toBe(1);
      expect(out.join('\n')).toContain('already in progress');
    });
  });
});
