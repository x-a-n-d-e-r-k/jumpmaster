import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewDropPayload, DropPayload, ItemDropPayload } from '@jumpmaster/protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_DISALLOWED_TOOLS } from '../claude.js';
import { roleWorld } from '../test/roleWorld.js';
import { runCrew } from './crew.js';
import { runImplement } from './implement.js';
import { runReview } from './review.js';
import { FOREGROUND_NOTE, type RoleCtx } from './shared.js';

const credentials = {
  claudeToken: 'sk-ant-' + 'oat-SECRET1234567890',
  forgeToken: 'ghp_FORGE1234567890',
};
const common = {
  protocol: 1 as const,
  dropId: 'd1',
  epoch: 1,
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'do it',
  image: 'img',
  protectedPaths: ['.github/**'],
  credentials,
};
const gate = (timeoutMinutes: number) => ({ name: `g${timeoutMinutes}`, run: 'x', timeoutMinutes });
const implement = (gates = [gate(5)]): ItemDropPayload =>
  ({
    ...common,
    role: 'implement',
    resume: false,
    issue: { number: 1, title: 't', body: 'b' },
    branch: 'agent/issue-1',
    gates,
  }) as ItemDropPayload;
const review = (gates = [gate(5)]): ItemDropPayload =>
  ({
    ...common,
    role: 'review',
    issue: { number: 1, title: 't', body: 'b' },
    branch: 'agent/issue-1',
    pr: { number: 9, branch: 'agent/issue-1', headSha: 'h9' },
    gates,
  }) as ItemDropPayload;
const crew: CrewDropPayload = { ...common, role: 'crew-lead' };

function newCtx(): RoleCtx {
  return {
    workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-fg-')),
    secrets: [credentials.claudeToken],
    ids: null,
  };
}

const runners = {
  implement: (p: DropPayload, w: ReturnType<typeof roleWorld>) => runImplement(p, w.deps, newCtx()),
  review: (p: DropPayload, w: ReturnType<typeof roleWorld>) => runReview(p, w.deps, newCtx()),
  crew: (p: DropPayload, w: ReturnType<typeof roleWorld>) => runCrew(p, w.deps, newCtx()),
};
const drops: [keyof typeof runners, DropPayload][] = [
  ['implement', implement()],
  ['review', review()],
  ['crew', crew],
];

async function recorded(role: keyof typeof runners, payload: DropPayload) {
  const w = roleWorld();
  await runners[role](payload, w);
  expect(w.claude.runs).toBe(1);
  return {
    env: w.claude.env[0] ?? {},
    args: w.claude.args[0] ?? [],
    systemPrompt: w.claude.systemPrompts[0] ?? '',
  };
}

const KEYS = [
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('every runAgent role runs claude in the foreground (#745)', () => {
  for (const [role, payload] of drops) {
    test(`${role}: the environment disables background tasks and sets both Bash timeouts`, async () => {
      const { env } = await recorded(role, payload);
      expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
      expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('1200000');
      expect(env.BASH_MAX_TIMEOUT_MS).toBe('1200000');
    });

    test(`${role}: the container's own values of the same names don't override them`, async () => {
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '0';
      process.env.BASH_DEFAULT_TIMEOUT_MS = '5';
      process.env.BASH_MAX_TIMEOUT_MS = '99999999';
      const { env } = await recorded(role, payload);
      expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
      expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('1200000');
      expect(env.BASH_MAX_TIMEOUT_MS).toBe('1200000');
    });

    test(`${role}: the background tools are denied`, async () => {
      const { args } = await recorded(role, payload);
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe(AGENT_DISALLOWED_TOOLS);
    });

    test(`${role}: the system prompt says nothing can wake the session after its answer`, async () => {
      const { systemPrompt } = await recorded(role, payload);
      expect(systemPrompt).toContain(FOREGROUND_NOTE);
    });
  }

  test('a gate over 20 minutes raises both timeouts to its limit', async () => {
    for (const p of [implement([gate(5), gate(45)]), review([gate(45), gate(10)])]) {
      const { env } = await recorded(p.role === 'review' ? 'review' : 'implement', p);
      expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('2700000');
      expect(env.BASH_MAX_TIMEOUT_MS).toBe('2700000');
    }
  });

  test('gates of 20 minutes or less keep both timeouts at 20 minutes', async () => {
    const { env } = await recorded('implement', implement([gate(20), gate(1)]));
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('1200000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('1200000');
  });

  test('the sentence is exactly the issue text', () => {
    expect(FOREGROUND_NOTE).toBe(
      'Run commands in the foreground and wait for them. Stop any server you start before you answer. Nothing can wake this session after your final answer.',
    );
  });
});
