// GitLab reads for a merge request head on a project with "Pipelines must succeed" on (#885): the
// required checks from `getBranchRules` and the checks from `checksFor`, read through a real
// `GitLabForge` from the fake GitLab, for the flow and goal-change tests.
import type { ChecksFacts } from '../forge/github.js';
import { GitLabForge } from '../forge/gitlab.js';
import { ACCESS, fakeGitLab } from './fake-gitlab.js';

const GITLAB = 'https://gitlab.example.com';
// A made-up token, built at run time so no token-shaped literal sits in the tracked file.
const TOKEN = ['glpat', 'P'.repeat(20)].join('-');

export type GitLabPipelineCase = 'green' | 'none' | 'running' | 'failed' | 'jobless-failed';

export async function gitlabPipelineReads(
  c: GitLabPipelineCase,
): Promise<{ sha: string; requiredChecks: string[]; checks: ChecksFacts }> {
  const gl = fakeGitLab({
    baseUrl: GITLAB,
    project: {
      id: 91,
      path: 'group/pipeline-required',
      defaultBranch: 'main',
      onlyAllowMergeIfPipelineSucceeds: true,
    },
  });
  try {
    gl.addUser({ username: 'agent', token: TOKEN, accessLevel: ACCESS.developer });
    gl.protectBranch({ name: 'main' });
    const sha = gl.seedCommit({ branch: 'main', files: { a: '1' }, message: 'a' });
    const job = { green: 'success', running: 'running', failed: 'failed' } as const;
    if (c === 'jobless-failed') gl.seedPipeline({ sha, jobs: [], status: 'failed' });
    else if (c !== 'none')
      gl.seedPipeline({
        sha,
        jobs: [
          { name: 'build', status: 'success' },
          { name: 'test', status: job[c] },
        ],
      });
    const forge = new GitLabForge(GITLAB, 'group/pipeline-required', TOKEN);
    const rules = await forge.getBranchRules('main');
    if (rules.kind !== 'ok') throw new Error(`branch rules read ${rules.kind}`);
    return { sha, requiredChecks: rules.rules.requiredChecks, checks: await forge.checksFor(sha) };
  } finally {
    gl.stop();
  }
}
