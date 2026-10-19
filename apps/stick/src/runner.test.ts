import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { DropClient } from './client.js';
import type { ContainerDriver } from './driver.js';
import { runDrop } from './runner.js';

const TOKEN = 'sk-secret-claude-token';
const payload: DropPayload = DropPayloadSchema.parse({
  protocol: 1,
  dropId: 'd1',
  epoch: 3,
  role: 'implement',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  gates: [],
  model: 'm',
  maxTurns: 5,
  promptVersion: 'v1',
  prompt: 'p',
  credentials: { claudeToken: TOKEN, forgeToken: 'ghs_forge' },
});

function fakeDriver(lines: string[], opts: { hang?: boolean; exitCode?: number } = {}) {
  const d = {
    started: undefined as Parameters<ContainerDriver['start']>[0] | undefined,
    stopped: false,
    stopGrace: 0,
    driver: {
      async start(o) {
        d.started = o;
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        return {
          async *logs() {
            for (const l of lines) yield l;
            if (opts.hang) await gate;
          },
          async wait() {
            if (opts.hang) await gate;
            return { exitCode: d.stopped ? 137 : (opts.exitCode ?? 0) };
          },
          async stop(grace: number) {
            d.stopped = true;
            d.stopGrace = grace;
            release();
          },
        };
      },
    } satisfies ContainerDriver,
  };
  return d;
}

function fakeClient(heartbeatReply: 'ok' | 'cancel' | 'stale' = 'ok') {
  return {
    events: [] as TrooperEvent[][],
    result: undefined as DropResult | undefined,
    heartbeatReply,
    async heartbeat() {
      return this.heartbeatReply;
    },
    async postEvents(_d: string, _e: number, ev: TrooperEvent[]) {
      this.events.push(ev);
      return 'ok' as const;
    },
    async postResult(_d: string, _e: number, r: DropResult) {
      this.result = r;
      return 'ok' as const;
    },
  } satisfies DropClient & Record<string, unknown>;
}

describe('runDrop', () => {
  test('relays events and posts the result', async () => {
    const d = fakeDriver([
      'JM_EVENT {"ts":"t","kind":"phase","data":{"phase":"clone"}}',
      'JM_RESULT {"status":"completed","headSha":"a","gates":[]}',
    ]);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10 });
    expect(client.events.flat()).toHaveLength(1);
    expect(client.result).toMatchObject({ status: 'completed', headSha: 'a' });
  });

  test('exit without result reports failed', async () => {
    const d = fakeDriver(['plain log line'], { exitCode: 2 });
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10 });
    expect(client.result).toEqual({
      status: 'failed',
      reason: 'trooper exited 2 without result',
      gates: [],
    });
  });

  test('stale heartbeat stops the container with a 30s grace', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('stale');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10 });
    expect(d.stopped).toBe(true);
    expect(d.stopGrace).toBe(30_000);
  });

  test('cancel heartbeat stops the container', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('cancel');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10 });
    expect(d.stopped).toBe(true);
  });

  test('payload goes to the driver and no file containing the token is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-stick-test-'));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      const d = fakeDriver(['JM_RESULT {"status":"no_changes","gates":[]}']);
      await runDrop(payload, { client: fakeClient(), driver: d.driver, heartbeatMs: 10 });
      expect(JSON.parse(d.started?.payload ?? '{}').credentials.claudeToken).toBe(TOKEN);
      expect(d.started?.labels).toEqual({ 'jumpmaster.drop': 'd1', 'jumpmaster.epoch': '3' });
      for (const f of readdirSync(dir))
        expect(readFileSync(join(dir, f), 'utf8')).not.toContain(TOKEN);
    } finally {
      process.env.TMPDIR = prev;
    }
  });

  test('batches at most 50 events per post', async () => {
    const line = 'JM_EVENT {"ts":"t","kind":"log","data":{}}';
    const d = fakeDriver([
      ...Array(120).fill(line),
      'JM_RESULT {"status":"no_changes","gates":[]}',
    ]);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10 });
    expect(client.events.flat()).toHaveLength(120);
    expect(Math.max(...client.events.map((b) => b.length))).toBeLessThanOrEqual(50);
  });

  test('logs() throwing stops the container and posts a failed result', async () => {
    const d = fakeDriver([]);
    const driver: ContainerDriver = {
      async start(o) {
        const h = await d.driver.start(o);
        return {
          ...h,
          async *logs() {
            throw new Error('boom');
          },
        };
      },
    };
    const client = fakeClient();
    await runDrop(payload, { client, driver, heartbeatMs: 10 });
    expect(d.stopped).toBe(true);
    expect(client.result).toMatchObject({ status: 'failed', reason: 'stick runner error: boom' });
  });
});
