import type { Forge, ForgeIssue } from '../forge/github.js';

export type PullRequestInput = Parameters<Forge['findOrCreatePullRequest']>[0];

export interface FakeForge extends Forge {
  created: PullRequestInput[];
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`not implemented in fakeForge: ${name}`);
  };
}

export function fakeForge(opts: {
  issues: ForgeIssue[];
  trusted: string[];
  defaultBranch?: string;
}): FakeForge {
  const created: PullRequestInput[] = [];
  return {
    created,
    viewerLogin: notImplemented('viewerLogin'),
    getPull: notImplemented('getPull'),
    findOpenPullByHead: notImplemented('findOpenPullByHead'),
    listOpenAgentPulls: notImplemented('listOpenAgentPulls'),
    getIssueState: notImplemented('getIssueState'),
    getIssueLabels: notImplemented('getIssueLabels'),
    branchSha: notImplemented('branchSha'),
    compare: notImplemented('compare'),
    listPullFiles: notImplemented('listPullFiles'),
    checksFor: notImplemented('checksFor'),
    getBranchRules: notImplemented('getBranchRules'),
    getFileAt: notImplemented('getFileAt'),
    listReviews: notImplemented('listReviews'),
    createReview: notImplemented('createReview'),
    findReviewByMarker: notImplemented('findReviewByMarker'),
    merge: notImplemented('merge'),
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
