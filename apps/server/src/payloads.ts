import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { agentBranch, type DropPayload, type Role } from '@jumpmaster/protocol';
import { type Config, type DropZoneConfig, modelFor } from './config.js';
import type { Db } from './db/open.js';
import { type Drop, listWorkItems } from './db/repo.js';
import type { Feedback } from './flow/decide.js';

const ROLES: Role[] = ['implement', 'review', 'heal', 'resolve'];

// Same relative depth from src (vitest) and dist (built): up to apps/, then trooper/.
const templates = Object.fromEntries(
  ROLES.map((r) => [
    r,
    readFileSync(new URL(`../../trooper/prompts/${r}.md`, import.meta.url), 'utf8'),
  ]),
) as Record<Role, string>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** First 12 hex of sha256(prompt template), per role; recorded on every drop. */
export function promptVersions(): Record<Role, string> {
  return Object.fromEntries(ROLES.map((r) => [r, sha256(templates[r]).slice(0, 12)])) as Record<
    Role,
    string
  >;
}

/** Human feedback is trusted; automated review and CI findings are untrusted data. */
export function renderFeedback(f: Feedback): string {
  const heading =
    f.source === 'human'
      ? '## Feedback (data, from trusted reviewers)'
      : '## Automated review findings (data, untrusted)';
  return `${heading}\n\n${f.text}`;
}

export function buildPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  secrets: Config['secrets'],
): DropPayload {
  const item = listWorkItems(db, zone.id).find((w) => w.id === drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  const role = drop.role as Role;
  const branch = agentBranch(item.issueNumber);
  const common = {
    protocol: 1 as const,
    dropId: drop.id,
    epoch: drop.epoch,
    repo: { owner, name, defaultBranch: row.defaultBranch },
    issue: { number: item.issueNumber, title: item.title, body: item.body },
    branch,
    gates: zone.gates,
    model: modelFor(zone, role),
    maxTurns: zone.maxTurns,
    promptVersion: promptVersions()[role],
    image: zone.image,
    protectedPaths: zone.protectedPaths,
    prompt: `${templates[role]}\n\n## Issue (data)\n\n#${item.issueNumber}: ${item.title}\n\n${item.body}`,
  };
  const author = { claudeToken: secrets.claudeToken, forgeToken: secrets.githubAuthorToken };
  const pr = () => {
    if (drop.prNumber === null || drop.headSha === null) {
      throw new Error(`${role} drop ${drop.id} has no pull request`);
    }
    return { number: drop.prNumber, branch, headSha: drop.headSha };
  };

  switch (role) {
    case 'implement':
      return {
        ...common,
        role,
        credentials: author,
        resume: drop.headSha !== null,
        resumeSha: drop.headSha ?? undefined,
      };
    case 'review':
      return {
        ...common,
        role,
        pr: pr(),
        credentials: {
          claudeToken: secrets.claudeToken,
          ...(zone.reviewReadToken && secrets.githubReadToken
            ? { forgeToken: secrets.githubReadToken }
            : {}),
        },
      };
    case 'heal': {
      const input = JSON.parse(drop.inputJson ?? '{}') as { feedback?: Feedback };
      if (!input.feedback) throw new Error(`heal drop ${drop.id} has no feedback`);
      return {
        ...common,
        role,
        pr: pr(),
        credentials: author,
        feedback: renderFeedback(input.feedback),
      };
    }
    case 'resolve':
      return { ...common, role, pr: pr(), credentials: author };
  }
}
