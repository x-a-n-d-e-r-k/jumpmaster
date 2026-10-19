import type {
  BranchRulesRead,
  ChecksFacts,
  CompareFacts,
  Forge,
  ForgeError,
  ForgeIssue,
  ForgeReview,
  PullFacts,
  PullFiles,
} from '../forge/github.js';

export type PullRequestInput = Parameters<Forge['findOrCreatePullRequest']>[0];

export type Identity = 'author' | 'reviewer';

export type FailMode = 'throw' | '5xx' | '5xx-after-success' | { status: number; message?: string };

export interface FakeForge extends Forge {
  /** Makes the next call of `method` fail (queued; one entry per call). */
  failNext(method: keyof Forge, mode: FailMode): void;
  calls: { method: string; identity: Identity; args: unknown[] }[];
}

export type StateReview = ForgeReview & { pr: number };

export interface FakeForgeState {
  repo: string;
  defaultBranch: string;
  logins: Record<Identity, string>;
  trusted: string[];
  pulls: Map<number, PullFacts>;
  addPull(
    p: Partial<PullFacts> & { headRef: string; headSha: string; author: string; number?: number },
  ): PullFacts;
  reopen(number: number): void;
  close(number: number): void;
  /** A human merge: sets the PR merged without recording anything in `merges`. */
  markMerged(number: number): void;
  /** Force-push: moves the PR head and its branch. */
  setHead(number: number, sha: string): void;
  branches: Map<string, string>;
  deleteBranch(name: string): void;
  issues: Map<number, { state: 'open' | 'closed'; labels: string[] }>;
  closeIssue(n: number): void;
  reopenIssue(n: number): void;
  setLabels(n: number, labels: string[]): void;
  checks: Map<string, ChecksFacts>;
  compares: Map<string, CompareFacts>;
  reviews: StateReview[];
  /** Appends a review (defaults: `pr: 1`, a human author, `APPROVED` on the PR head). */
  review(r?: Partial<StateReview>): StateReview;
  files: Map<string, string>;
  pullFiles: Map<number, PullFiles>;
  rules: Record<Identity, BranchRulesRead>;
  merges: { number: number; sha: string; title: string; message: string }[];
}

const STATE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function forgeError(status: number | undefined, message: string): ForgeError {
  const err: ForgeError = new Error(message);
  if (status !== undefined) err.status = status;
  return err;
}

function mustPull(state: FakeForgeState, number: number): PullFacts {
  const p = state.pulls.get(number);
  if (!p) throw forgeError(404, `no pull ${number}`);
  return p;
}

function mustIssue(state: FakeForgeState, n: number) {
  const i = state.issues.get(n);
  if (!i) throw forgeError(404, `no issue ${n}`);
  return i;
}

function createState(opts: {
  issues: ForgeIssue[];
  trusted: string[];
  defaultBranch?: string;
  authorLogin?: string;
  reviewerLogin?: string;
  firstPullNumber?: number;
}): FakeForgeState {
  let nextPull = opts.firstPullNumber ?? 1;
  let nextReview = 1;
  const defaultBranch = opts.defaultBranch ?? 'main';
  const okRules = (): BranchRulesRead => ({
    kind: 'ok',
    rules: {
      requiredApprovals: 1,
      dismissStaleOnPush: true,
      requiredChecks: [],
      unpinnedChecks: [],
      viewerCanBypass: false,
      viewerIsAdmin: false,
    },
  });
  const state: FakeForgeState = {
    repo: 'octo/demo',
    defaultBranch,
    logins: {
      author: opts.authorLogin ?? 'author-bot',
      reviewer: opts.reviewerLogin ?? 'reviewer-bot',
    },
    trusted: [...opts.trusted],
    pulls: new Map(),
    addPull(p) {
      const number = p.number ?? nextPull;
      nextPull = Math.max(nextPull, number + 1);
      const issue = /^agent\/issue-(\d+)$/.exec(p.headRef)?.[1];
      const pull: PullFacts = {
        title: issue ? `Issue ${issue}` : p.headRef,
        state: 'open',
        merged: false,
        headRepo: state.repo,
        baseRef: state.defaultBranch,
        ...p,
        number,
      };
      state.pulls.set(number, pull);
      state.branches.set(p.headRef, p.headSha);
      return pull;
    },
    reopen(number) {
      mustPull(state, number).state = 'open';
    },
    close(number) {
      mustPull(state, number).state = 'closed';
    },
    markMerged(number) {
      const p = mustPull(state, number);
      p.merged = true;
      p.state = 'closed';
    },
    setHead(number, sha) {
      const p = mustPull(state, number);
      p.headSha = sha;
      state.branches.set(p.headRef, sha);
    },
    branches: new Map(),
    deleteBranch(name) {
      state.branches.delete(name);
      for (const p of state.pulls.values()) {
        if (p.headRef === name && p.state === 'open') p.state = 'closed';
      }
    },
    issues: new Map(opts.issues.map((i) => [i.number, { state: 'open', labels: [...i.labels] }])),
    closeIssue(n) {
      mustIssue(state, n).state = 'closed';
    },
    reopenIssue(n) {
      mustIssue(state, n).state = 'open';
    },
    setLabels(n, labels) {
      mustIssue(state, n).labels = [...labels];
    },
    checks: new Map(),
    compares: new Map(),
    reviews: [],
    review(r = {}) {
      const pr = r.pr ?? 1;
      const id = r.id ?? nextReview;
      nextReview = Math.max(nextReview, id + 1);
      const rv: StateReview = {
        author: 'human',
        state: 'APPROVED',
        commitId: state.pulls.get(pr)?.headSha ?? '',
        body: '',
        submittedAt: new Date(STATE_EPOCH + id * 1000).toISOString(),
        ...r,
        pr,
        id,
      };
      state.reviews.push(rv);
      return rv;
    },
    files: new Map(),
    pullFiles: new Map(),
    rules: { author: okRules(), reviewer: okRules() },
    merges: [],
  };
  return state;
}

function forgeFor(
  state: FakeForgeState,
  identity: Identity,
  readyIssues: (label: string) => ForgeIssue[],
): FakeForge {
  const me = () => state.logins[identity];
  const impl: Forge = {
    getDefaultBranch: async () => state.defaultBranch,
    listReadyIssues: async (label) => readyIssues(label),
    isTrusted: async (login) => state.trusted.includes(login),
    viewerLogin: async () => me(),
    findOrCreatePullRequest: async (input) => {
      const open = [...state.pulls.values()].find(
        (p) => p.state === 'open' && p.headRef === input.head && p.headRepo === state.repo,
      );
      if (open) {
        return {
          number: open.number,
          url: `https://example.test/pull/${open.number}`,
          created: false,
        };
      }
      const sha = state.branches.get(input.head);
      const p = state.addPull({
        headRef: input.head,
        headSha: sha ?? '',
        author: me(),
        title: input.title,
        baseRef: input.base,
      });
      // M0 callers open PRs for branches the fake never saw pushed: no head, no branch.
      if (sha === undefined) {
        p.headSha = null;
        state.branches.delete(input.head);
      }
      return { number: p.number, url: `https://example.test/pull/${p.number}`, created: true };
    },
    getPull: async (n) => {
      const p = state.pulls.get(n);
      return p ? { ...p } : null;
    },
    findOpenPullByHead: async (branch) => {
      const p = [...state.pulls.values()].find(
        (x) => x.state === 'open' && x.headRef === branch && x.headRepo === state.repo,
      );
      return p ? { ...p } : null;
    },
    listOpenAgentPulls: async (prefix) =>
      [...state.pulls.values()]
        .filter(
          (p) => p.state === 'open' && p.headRef.startsWith(prefix) && p.headRepo === state.repo,
        )
        .map((p) => ({ ...p })),
    getIssueState: async (n) => mustIssue(state, n).state,
    getIssueLabels: async (n) => [...mustIssue(state, n).labels],
    branchSha: async (b) => state.branches.get(b) ?? null,
    compare: async (base, head) => ({
      ...(state.compares.get(`${base}...${head}`) ?? {
        aheadBy: 1,
        behindBy: 0,
        baseSha: 'base0',
        mergeBaseSha: 'base0',
      }),
    }),
    listPullFiles: async (n) =>
      structuredClone(state.pullFiles.get(n) ?? { files: [{ path: 'src/a.ts' }], complete: true }),
    checksFor: async (sha) =>
      structuredClone(state.checks.get(sha) ?? { state: 'none' as const, names: [] }),
    getBranchRules: async () => structuredClone(state.rules[identity]),
    getFileAt: async (ref, path) => state.files.get(`${ref}:${path}`) ?? null,
    listReviews: async (n) => state.reviews.filter((r) => r.pr === n).map(({ pr: _pr, ...r }) => r),
    createReview: async (n, input) => {
      mustPull(state, n);
      const rv = state.review({
        pr: n,
        author: me(),
        state: input.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
        commitId: input.commitId,
        body: input.body,
      });
      return { id: rv.id };
    },
    findReviewByMarker: async (n, marker) => {
      const hit = state.reviews.find(
        (r) => r.pr === n && r.author === me() && r.body.trimEnd().split('\n').pop() === marker,
      );
      return hit ? { id: hit.id } : null;
    },
    merge: async (n, input) => {
      const p = mustPull(state, n);
      if (p.state !== 'open' || p.merged) throw forgeError(405, 'Pull Request is not mergeable');
      if (p.headSha !== input.sha) {
        throw forgeError(409, 'Head branch was modified. Review and try the merge again.');
      }
      p.merged = true;
      p.state = 'closed';
      state.merges.push({ number: n, sha: input.sha, title: input.title, message: input.message });
      return { merged: true, sha: `merge-${n}` };
    },
  };

  const failures = new Map<string, FailMode[]>();
  const calls: FakeForge['calls'] = [];
  const forge = { calls } as FakeForge;
  forge.failNext = (method, mode) => {
    failures.set(method, [...(failures.get(method) ?? []), mode]);
  };
  for (const name of Object.keys(impl) as (keyof Forge)[]) {
    const fn = impl[name] as (...args: unknown[]) => Promise<unknown>;
    (forge as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      calls.push({ method: name, identity, args });
      const mode = failures.get(name)?.shift();
      if (mode === undefined) return fn(...args);
      if (mode === 'throw') throw forgeError(undefined, `fake network error in ${name}`);
      if (mode === '5xx') throw forgeError(502, `fake 502 in ${name}`);
      if (mode === '5xx-after-success') {
        await fn(...args);
        throw forgeError(502, `fake 502 after ${name} succeeded`);
      }
      throw forgeError(mode.status, mode.message ?? `fake ${mode.status} in ${name}`);
    };
  }
  return forge;
}

/** Author and reviewer identities over one shared in-memory forge. */
export function fakeForgePair(opts: {
  issues: ForgeIssue[];
  trusted: string[];
  defaultBranch?: string;
  authorLogin?: string;
  reviewerLogin?: string;
}): { author: FakeForge; reviewer: FakeForge; state: FakeForgeState } {
  const state = createState(opts);
  const ready = (label: string): ForgeIssue[] =>
    opts.issues.flatMap((i) => {
      const s = state.issues.get(i.number);
      return s?.state === 'open' && s.labels.includes(label)
        ? [{ ...i, labels: [...s.labels] }]
        : [];
    });
  const author = forgeFor(state, 'author', ready);
  const reviewer = forgeFor(state, 'reviewer', ready);
  return { author, reviewer, state };
}

/**
 * The M0 single-identity fake: `listReadyIssues` returns `opts.issues` as given, PR numbers start
 * at 101, and every `findOrCreatePullRequest` input is recorded in `created`.
 */
export function fakeForge(opts: {
  issues: ForgeIssue[];
  trusted: string[];
  defaultBranch?: string;
}): FakeForge & { created: PullRequestInput[]; state: FakeForgeState } {
  const state = createState({ ...opts, firstPullNumber: 101 });
  const created: PullRequestInput[] = [];
  const forge = forgeFor(state, 'author', () => opts.issues);
  const findOrCreate = forge.findOrCreatePullRequest;
  forge.findOrCreatePullRequest = async (input) => {
    created.push(input);
    return findOrCreate(input);
  };
  return Object.assign(forge, { created, state });
}
