import { readFileSync } from 'node:fs';
import type { GateResult, MergeOutcome } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';

/** A recording fake for role tests: every git call is `[name, ...args]` in signature order. */
export function roleWorld(
  o: {
    dirty?: boolean;
    agentCommits?: string;
    checkoutError?: string;
    /** cloneRepo throws this message (e.g. a refused read token). */
    cloneError?: string;
    /** remoteBranchSha's answer (implement's fresh-branch check). */
    remoteSha?: string | null;
    /** checkMirror throws this message (a provided mirror that is missing or fails the check). */
    mirrorError?: string;
    /** mirrorBranchSha's answer (implement's fresh-branch check with a provided mirror). */
    mirrorSha?: string | null;
    rateLimited?: boolean;
    merge?: MergeOutcome;
    markers?: string[];
    mergeStuck?: boolean;
    summary?: string;
    noSummary?: boolean;
  } = {},
) {
  const calls: unknown[][] = [];
  const claude = {
    runs: 0,
    args: [] as string[][],
    env: [] as NodeJS.ProcessEnv[],
    systemPrompts: [] as string[],
  };
  let head = 'sha1';
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => {
        if (o.cloneError) throw new Error(o.cloneError);
      }),
      remoteBranchSha: rec('remoteBranchSha', () => o.remoteSha ?? null),
      checkMirror: rec('checkMirror', () => {
        if (o.mirrorError) throw new Error(o.mirrorError);
      }),
      cloneFromMirror: rec('cloneFromMirror', () => undefined),
      mirrorBranchSha: rec('mirrorBranchSha', () => o.mirrorSha ?? null),
      prepareBranch: rec('prepareBranch', () => undefined),
      mirrorFetch: rec('mirrorFetch', () => undefined),
      checkoutBranch: rec('checkoutBranch', () => {
        if (o.checkoutError) throw new Error(o.checkoutError);
      }),
      mergeBase: rec('mergeBase', () => o.merge ?? 'clean'),
      conflictMarkers: rec('conflictMarkers', () => o.markers ?? []),
      mergeInProgress: rec('mergeInProgress', () => o.mergeStuck ?? false),
      commitIfDirty: rec('commitIfDirty', () => {
        if (!o.dirty) return false;
        head = 'sha-new';
        return true;
      }),
      headSha: rec('headSha', () => head),
      aheadOfBase: rec('aheadOfBase', () => 1),
      sweepProcesses: () => false,
      cloneForGates: rec('cloneForGates', () => undefined),
      removeTree: rec('removeTree', () => undefined),
      treeState: rec('treeState', () => 'clean'),
      removeInstructionFiles: rec('removeInstructionFiles', () => []),
    },
    async *runClaude(args: string[], env: NodeJS.ProcessEnv) {
      claude.runs++;
      claude.args.push(args);
      claude.env.push(env);
      // Doctor's probe has no system-prompt file.
      const at = args.indexOf('--append-system-prompt-file');
      const file = at === -1 ? undefined : args[at + 1];
      claude.systemPrompts.push(file ? readFileSync(file, 'utf8') : '');
      if (o.agentCommits) head = o.agentCommits;
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
      if (o.rateLimited) {
        yield JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
        return;
      }
      yield JSON.stringify({
        type: 'result',
        is_error: false,
        terminal_reason: 'completed',
        session_id: 's',
        structured_output: o.noSummary
          ? { status: 'COMPLETE' }
          : { status: 'COMPLETE', summary: o.summary ?? 'done' },
      });
    },
    runGates: async (gates: { name: string }[]): Promise<GateResult[]> => {
      calls.push(['runGates']);
      return gates.map((g) => ({
        name: g.name,
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        outputTail: '',
      }));
    },
    emit: () => undefined,
  } as unknown as TrooperDeps;
  return { deps, calls, claude, names: () => calls.map((c) => c[0]) };
}
