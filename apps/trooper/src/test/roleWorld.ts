import type { GateResult, MergeOutcome } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';

/** A recording fake for role tests: every git call is `[name, ...args]` in signature order. */
export function roleWorld(
  o: {
    dirty?: boolean;
    agentCommits?: string;
    pushError?: string;
    checkoutError?: string;
    rateLimited?: boolean;
    merge?: MergeOutcome;
    markers?: string[];
    mergeStuck?: boolean;
  } = {},
) {
  const calls: unknown[][] = [];
  const claude = { runs: 0, args: [] as string[][] };
  let head = 'sha1';
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => undefined),
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
      pushExistingBranch: rec('pushExistingBranch', () => {
        if (o.pushError) throw new Error(o.pushError);
        return 'pushed';
      }),
      pushNewBranch: rec('pushNewBranch', () => 'pushed'),
      sweepProcesses: () => false,
      cloneForGates: rec('cloneForGates', () => undefined),
      removeTree: rec('removeTree', () => undefined),
    },
    async *runClaude(args: string[]) {
      claude.runs++;
      claude.args.push(args);
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
        structured_output: { status: 'COMPLETE', summary: 'done' },
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
