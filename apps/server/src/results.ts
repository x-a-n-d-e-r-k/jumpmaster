import { agentBranch, type DropResult, type GateResult } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';
import { getDrop, listWorkItems, setWorkItemState, updateDrop } from './db/repo.js';
import type { Forge } from './forge/github.js';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function gateTable(gates: GateResult[]): string {
  const rows = gates.map((g) => {
    const exit = g.timedOut ? 'timeout' : g.exitCode === null ? 'n/a' : String(g.exitCode);
    return `| ${cell(g.name)} | ${exit} | ${(g.durationMs / 1000).toFixed(1)} |`;
  });
  return ['| Gate | Exit | Duration (s) |', '| --- | --- | --- |', ...rows].join('\n');
}

/** Turns a finished drop's result into a PR (completed) or a parked work item, and closes the drop. */
export async function applyResult(
  db: Db,
  forge: Forge,
  dropId: string,
  result: DropResult,
): Promise<void> {
  const drop = getDrop(db, dropId);
  if (!drop) throw new Error(`unknown drop ${dropId}`);
  const item = listWorkItems(db, drop.dropZoneId).find((w) => w.id === drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);

  let status = result.status;
  let reason = result.reason;
  if (status === 'completed' && !result.headSha) {
    status = 'failed';
    reason = 'completed without headSha';
  }

  if (status === 'completed') {
    const zone = db
      .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
      .get(drop.dropZoneId) as { defaultBranch: string };
    const body = [
      `Implements #${item.issueNumber}.`,
      '',
      '### Gates',
      '',
      gateTable(result.gates),
      '',
      `Closes #${item.issueNumber}`,
    ].join('\n');
    const pr = await forge.findOrCreatePullRequest({
      head: agentBranch(item.issueNumber),
      base: zone.defaultBranch,
      title: item.title,
      body,
    });
    db.transaction(() => {
      setWorkItemState(db, item.id, 'pr_open');
      db.prepare('UPDATE work_items SET pr_number = ? WHERE id = ?').run(pr.number, item.id);
      updateDrop(db, dropId, { state: 'succeeded' });
    })();
    return;
  }

  db.transaction(() => {
    setWorkItemState(db, item.id, 'parked', reason ?? status);
    updateDrop(db, dropId, { state: status === 'failed' ? 'failed' : 'succeeded' });
  })();
}
