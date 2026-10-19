import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Config, DropZoneConfig } from './config.js';
import type { Drop } from './db/repo.js';
import { buildPayload, promptVersions, renderFeedback } from './payloads.js';
import { seedQueuedDrop, t0 } from './test/helpers.js';

const secrets: Config['secrets'] = {
  claudeToken: 'claude-secret',
  githubAuthorToken: 'author-secret',
  githubReviewerToken: 'reviewer-secret',
  githubReadToken: 'read-secret',
  joinToken: 'join-me',
};

const zone = {
  id: 'main',
  repo: 'octo/demo',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
  image: 'jm-trooper:test',
  model: 'claude-opus-5-5',
  models: { review: 'claude-sonnet-5-5' },
  maxTurns: 200,
  protectedPaths: ['.github/**', 'CLAUDE.md'],
  reviewReadToken: false,
} as unknown as DropZoneConfig;

const base: Drop = {
  id: 'dx',
  dropZoneId: 'main',
  workItemId: 1,
  role: 'implement',
  state: 'leased',
  stickId: 's1',
  epoch: 1,
  leaseExpiresAt: null,
  promptVersion: null,
  image: null,
  resultJson: null,
  createdAt: t0.toISOString(),
  startedAt: null,
  finishedAt: null,
  fingerprint: null,
  prNumber: null,
  headSha: null,
  inputJson: null,
  chargedKey: null,
};
const impl = base;
const review: Drop = { ...base, role: 'review', prNumber: 5, headSha: 'h1' };
const heal: Drop = {
  ...base,
  role: 'heal',
  prNumber: 5,
  headSha: 'ck1',
  inputJson: JSON.stringify({ feedback: { source: 'review', text: 'Fix the thing' } }),
};
const resolve: Drop = { ...base, role: 'resolve', prNumber: 5, headSha: 'h1' };

const db = seedQueuedDrop();
const build = (d: Drop, z: DropZoneConfig = zone) => buildPayload(db, z, d, secrets);

describe('buildPayload', () => {
  test('no payload ever carries the reviewer token', () => {
    for (const d of [impl, review, heal, resolve]) {
      expect(JSON.stringify(build(d))).not.toContain(secrets.githubReviewerToken);
    }
  });

  test('review payload never carries the author or reviewer token', () => {
    const s = JSON.stringify(build(review));
    expect(s).not.toContain(secrets.githubAuthorToken);
    expect(s).not.toContain(secrets.githubReviewerToken);
  });

  test('review carries the read token only when reviewReadToken', () => {
    expect(build(review).credentials.forgeToken).toBeUndefined();
    expect(build(review, { ...zone, reviewReadToken: true }).credentials.forgeToken).toBe(
      'read-secret',
    );
  });

  test('implement, heal and resolve carry the author token', () => {
    for (const d of [impl, heal, resolve]) {
      expect(build(d).credentials.forgeToken).toBe('author-secret');
    }
  });

  test('implement with a headSha resumes', () => {
    expect(build({ ...impl, headSha: 'ck1' })).toMatchObject({ resume: true, resumeSha: 'ck1' });
    expect(build(impl)).toMatchObject({ resume: false });
  });

  test('pr roles carry the pr from the drop, heal starts from its checkpoint', () => {
    expect(build(review)).toMatchObject({
      pr: { number: 5, branch: 'agent/issue-1', headSha: 'h1' },
    });
    expect(build(heal)).toMatchObject({ pr: { number: 5, headSha: 'ck1' } });
    expect(build(resolve)).toMatchObject({ pr: { number: 5 } });
  });

  test('heal feedback is rendered from input_json', () => {
    const p = build(heal);
    expect(p.role === 'heal' && p.feedback).toBe(
      renderFeedback({ source: 'review', text: 'Fix the thing' }),
    );
  });

  test('payload carries zone protectedPaths', () => {
    expect(build(impl).protectedPaths).toEqual(['.github/**', 'CLAUDE.md']);
  });

  test('payload carries zone image and role model', () => {
    expect(build(impl)).toMatchObject({ image: 'jm-trooper:test', model: 'claude-opus-5-5' });
    expect(build(review)).toMatchObject({ model: 'claude-sonnet-5-5' });
  });

  test('prompt is the role template plus the issue under a data heading', () => {
    const p = build(review);
    expect(p.promptVersion).toBe(promptVersions().review);
    expect(p.prompt).toMatch(/\n\n## Issue \(data\)\n\n#1: t\n\nb$/);
  });
});

describe('renderFeedback', () => {
  test('automated findings never sit under the trusted heading', () => {
    for (const source of ['review', 'ci'] as const) {
      const out = renderFeedback({ source, text: 'x' });
      expect(out).not.toContain('trusted reviewers');
      expect(out).toContain('## Automated review findings (data, untrusted)');
    }
  });
  test('human feedback sits under the trusted heading', () => {
    expect(renderFeedback({ source: 'human', text: 'x' })).toContain(
      '## Feedback (data, from trusted reviewers)',
    );
  });
});

describe('prompts', () => {
  test('promptVersions differ per role and are 12 hex', () => {
    const v = promptVersions();
    expect(new Set(Object.values(v)).size).toBe(4);
    for (const x of Object.values(v)) expect(x).toMatch(/^[0-9a-f]{12}$/);
  });
  test('review.md names weakened tests as a blocker', () => {
    const t = readFileSync(new URL('../../trooper/prompts/review.md', import.meta.url), 'utf8');
    expect(t).toMatch(/deleted, skipped or weakened tests[^.]*blocker/i);
  });
  test('every template keeps the shared rules', () => {
    for (const r of ['implement', 'review', 'heal', 'resolve']) {
      const t = readFileSync(new URL(`../../trooper/prompts/${r}.md`, import.meta.url), 'utf8');
      expect(t).toMatch(/Co-Authored-By/);
      expect(t).toMatch(/Never push/i);
      expect(t).toMatch(/specification|data/i);
    }
  });
});
