import type { Forge, ForgeIssue } from '../forge/github.js';

export type PullRequestInput = Parameters<Forge['findOrCreatePullRequest']>[0];

export interface FakeForge extends Forge {
  created: PullRequestInput[];
}

export function fakeForge(opts: {
  issues: ForgeIssue[];
  trusted: string[];
  defaultBranch?: string;
}): FakeForge {
  const created: PullRequestInput[] = [];
  return {
    created,
    getDefaultBranch: async () => opts.defaultBranch ?? 'main',
    listReadyIssues: async () => opts.issues,
    isTrusted: async (login) => opts.trusted.includes(login),
    findOrCreatePullRequest: async (input) => {
      created.push(input);
      return {
        number: 100 + created.length,
        url: `https://example.test/pull/${100 + created.length}`,
        created: true,
      };
    },
  };
}
