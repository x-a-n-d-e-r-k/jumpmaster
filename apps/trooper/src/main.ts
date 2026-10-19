import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  EVENT_PREFIX,
  type GateResult,
  RESULT_PREFIX,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { buildClaudeArgs, parseStreamLine } from './claude.js';
import { runGates, scrubEnv } from './gates.js';
import * as gitOps from './git.js';
import { redact } from './redact.js';

export interface TrooperDeps {
  git: typeof import('./git.js');
  runClaude(args: string[], env: NodeJS.ProcessEnv, cwd: string): AsyncIterable<string>;
  runGates: typeof runGates;
  emit(line: string): void;
}

export async function runTrooper(payload: DropPayload, deps: TrooperDeps): Promise<DropResult> {
  const { claudeToken, forgeToken } = payload.credentials;
  const secrets = [
    claudeToken,
    forgeToken,
    Buffer.from(`x-access-token:${forgeToken}`).toString('base64'),
  ];
  const emitEvent = (kind: TrooperEvent['kind'], data: Record<string, unknown>): void => {
    const ev: TrooperEvent = { ts: new Date().toISOString(), kind, data };
    deps.emit(redact(EVENT_PREFIX + JSON.stringify(ev), secrets));
  };
  const finish = (r: DropResult): DropResult => {
    const out: DropResult =
      r.reason === undefined ? r : { ...r, reason: redact(r.reason, secrets) };
    deps.emit(redact(RESULT_PREFIX + JSON.stringify(out), secrets));
    return out;
  };

  const work = mkdtempSync(join(tmpdir(), 'trooper-'));
  const gates: GateResult[] = [];
  try {
    const repoDir = join(work, 'repo');
    const base = payload.repo.defaultBranch;

    emitEvent('phase', { phase: 'clone' });
    await deps.git.cloneRepo({
      owner: payload.repo.owner,
      name: payload.repo.name,
      token: forgeToken,
      dir: repoDir,
    });
    emitEvent('phase', { phase: 'branch', branch: payload.branch });
    await deps.git.prepareBranch(repoDir, payload.branch, base);

    const systemPromptFile = join(work, 'system.md');
    const settingsFile = join(work, 'settings.json');
    const gateList = payload.gates.map((g) => `- ${g.name}: ${g.run}`).join('\n');
    writeFileSync(
      systemPromptFile,
      `Before finishing, run these commands and make them pass:\n${gateList}\n`,
    );
    writeFileSync(settingsFile, JSON.stringify({ hooks: {} }));

    emitEvent('phase', { phase: 'claude' });
    const args = buildClaudeArgs({
      prompt: payload.prompt,
      model: payload.model,
      maxTurns: payload.maxTurns,
      systemPromptFile,
      settingsFile,
    });
    const claudeEnv: NodeJS.ProcessEnv = {
      ...scrubEnv(process.env, secrets),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
    };
    let claudeExit: number | undefined;
    let result: Extract<ReturnType<typeof parseStreamLine>, { type: 'result' }> | undefined;
    for await (const line of deps.runClaude(args, claudeEnv, repoDir)) {
      const parsed = parseStreamLine(line);
      if (parsed.type === 'ignored') continue;
      if (parsed.type === 'result') result = parsed;
      if (parsed.type === 'rate_limit') {
        emitEvent('rate_limit', {
          status: parsed.status,
          resetsAt: parsed.resetsAt,
          raw: parsed.raw,
        });
      } else if (parsed.type === 'agent') {
        const r = parsed.raw as { type?: unknown; exitCode?: unknown };
        if (r.type === 'claude_stderr' && typeof r.exitCode === 'number') claudeExit = r.exitCode;
        emitEvent('agent', { raw: parsed.raw });
      } else {
        emitEvent('agent', {
          result: true,
          isError: parsed.isError,
          terminalReason: parsed.terminalReason,
        });
      }
    }
    const meta = {
      usage: asRecord(result?.usage),
      modelUsage: asRecord(result?.modelUsage),
      numTurns: result?.numTurns,
    };
    const done = (r: Omit<DropResult, 'gates'>): DropResult =>
      finish({ ...stripUndefined(meta), ...r, gates });

    const exitNote = claudeExit === undefined ? '' : ` (claude exit ${claudeExit})`;
    if (result === undefined)
      return done({ status: 'failed', reason: `claude produced no result${exitNote}` });
    if (result.isError) {
      return done({
        status: 'failed',
        reason: `claude error: ${result.terminalReason ?? 'unknown'}${exitNote}`,
      });
    }
    const structured = result.structured as { status?: string; summary?: string } | undefined;
    if (structured?.status === 'BLOCKED') {
      return done({ status: 'blocked', reason: structured.summary ?? 'blocked' });
    }
    if (structured?.status !== 'COMPLETE') {
      return done({
        status: 'failed',
        reason: `claude returned no valid structured output${exitNote}`,
      });
    }

    emitEvent('phase', { phase: 'commit' });
    await deps.git.commitIfDirty(repoDir, `feat: implement #${payload.issue.number}`);
    if ((await deps.git.aheadOfBase(repoDir, base)) === 0) {
      return done({ status: 'no_changes', reason: structured.summary });
    }

    emitEvent('phase', { phase: 'gates' });
    const results = await deps.runGates(payload.gates, {
      cwd: repoDir,
      env: scrubEnv(process.env, secrets),
      secrets,
    });
    gates.push(...results);
    for (const g of results) {
      emitEvent('gate', {
        name: g.name,
        exitCode: g.exitCode,
        timedOut: g.timedOut,
        durationMs: g.durationMs,
        outputTail: g.outputTail,
      });
    }
    const failed = results.find((g) => g.timedOut || g.exitCode !== 0);
    if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

    emitEvent('phase', { phase: 'push' });
    await deps.git.pushNewBranch(repoDir, payload.branch, forgeToken);
    return done({ status: 'completed', headSha: await deps.git.headSha(repoDir) });
  } catch (err) {
    return finish({
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      gates,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function* spawnClaude(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): AsyncIterable<string> {
  const child = spawn('claude', args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-4000);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  exit.catch(() => undefined);
  for await (const line of createInterface({ input: child.stdout })) yield line;
  const code = await exit;
  if (code !== 0) yield JSON.stringify({ type: 'claude_stderr', exitCode: code, stderr });
}

export async function readPayload(
  file: string | undefined,
  stdin: AsyncIterable<string | Buffer>,
): Promise<DropPayload> {
  let text: string;
  if (file) text = readFileSync(file, 'utf8');
  else {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    text = Buffer.concat(chunks).toString('utf8');
  }
  return DropPayloadSchema.parse(JSON.parse(text));
}

async function main(): Promise<void> {
  const payload = await readPayload(process.argv[2], process.stdin);
  const result = await runTrooper(payload, {
    git: gitOps,
    runClaude: spawnClaude,
    runGates,
    emit: (l) => process.stdout.write(`${l}\n`),
  });
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
