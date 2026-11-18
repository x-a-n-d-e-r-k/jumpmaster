// One chat turn: fetch the zones the turn reads (as root, with their read tokens), then run one
// `claude -p … [--resume <session>]` as the agent uid, read-only, with the Claude token and the
// turn's MCP token in its environment and no forge credential anywhere in its reach. Its
// stream-json lines become ChatEvents.
import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatEvent, ChatTurnRequest, ChatZoneFetch } from '@jumpmaster/protocol';
import { parseStreamLine } from '../claude.js';
import { scrubEnv } from '../gates.js';
import { agentGitConfigFile, type SpawnFn } from '../git.js';
import {
  type AgentIdentity,
  agentSpawnOptions,
  asAgentInDirArgv,
  sweepUid,
  type TrooperIdentities,
  trooperIdentities,
} from '../privilege.js';
import { buildChatClaudeArgs, CHAT_MCP_TOKEN_ENV, chatMcpConfig } from './args.js';
import { type SyncResult, syncZone } from './repos.js';

/** The `chat-repos` volume's mount point in the chat service. */
export const DEFAULT_CHAT_REPOS = '/chat/repos';
const SUMMARY_MAX = 200;
const STDERR_TAIL = 8192;
const SESSION_LOST = /No conversation found with session ID/;

export type ChatTurnDeps = {
  spawn?: SpawnFn;
  /** Where the zones' mirrors and working copies live. */
  root?: string;
  /** The agent and gate identities; `undefined` reads them from the environment. */
  ids?: TrooperIdentities | null;
  /** A test seam for the fetch; the real one is `syncZone`. */
  sync?: (root: string, z: ChatZoneFetch, as: AgentIdentity | null) => Promise<SyncResult>;
};

const clip = (s: string): string =>
  s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One line naming a tool call ("read apps/x.ts"), from an assistant `tool_use` block. */
export function toolSummary(raw: unknown): { name: string; summary: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (b.type !== 'tool_use' || typeof b.name !== 'string' || b.name === '') return null;
  const input = (typeof b.input === 'object' && b.input !== null ? b.input : {}) as Record<
    string,
    unknown
  >;
  const mcp = /^mcp__jumpmaster__(.+)$/.exec(b.name);
  if (mcp) {
    const name = mcp[1] as string;
    const zone = str(input.zoneId);
    return { name, summary: clip(zone ? `${name} in ${zone}` : name) };
  }
  const name = b.name;
  let summary: string;
  switch (name) {
    case 'Read':
      summary = `read ${str(input.file_path)}`;
      break;
    case 'Grep':
      summary = `searched for ${str(input.pattern)}`;
      break;
    case 'Glob':
      summary = `listed ${str(input.pattern)}`;
      break;
    case 'Bash':
      summary = `ran ${str(input.command)}`;
      break;
    default:
      summary = `used ${name}`;
  }
  return { name, summary: clip(summary.trim()) };
}

/** The events one stream-json line gives, in order. */
function eventsOf(line: string): ChatEvent[] {
  const p = parseStreamLine(line);
  switch (p.type) {
    case 'init':
      return [{ type: 'session', sessionId: p.sessionId }];
    case 'rate_limit': {
      const { type: _t, raw: _r, ...data } = p;
      return [{ type: 'rate_limit', data }];
    }
    case 'result': {
      const usage =
        typeof p.usage === 'object' && p.usage !== null && !Array.isArray(p.usage)
          ? (p.usage as Record<string, unknown>)
          : undefined;
      return [
        {
          type: 'result',
          isError: p.isError,
          ...(usage ? { usage } : {}),
          ...(p.numTurns !== undefined ? { numTurns: p.numTurns } : {}),
          ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
        },
      ];
    }
    case 'agent': {
      const m = p.raw as { type?: unknown; message?: { content?: unknown } };
      if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return [];
      const out: ChatEvent[] = [];
      for (const block of m.message.content as unknown[]) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') {
          out.push({ type: 'text', text: b.text });
        } else {
          const t = toolSummary(block);
          if (t) out.push({ type: 'tool', ...t });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** The chat's rules (prompt.md) and then the server's system prompt for this thread. */
function systemPrompt(req: ChatTurnRequest): string {
  const rules = readFileSync(join(import.meta.dirname, 'prompt.md'), 'utf8');
  return `${rules.trimEnd()}\n\n${req.systemPrompt}\n`;
}

/** Per-turn directory for the system prompt file, removed when the turn ends. */
function turnDir(as: AgentIdentity | null): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'jm-chat-'));
  // Root owns it; the agent (claude) only needs to open the one file it is told the name of.
  if (as) chmodSync(dir, 0o711);
  return dir;
}

/** The environment of `claude`: no inherited credential, the two turn tokens, nothing else. */
function claudeEnv(req: ChatTurnRequest, as: AgentIdentity | null): NodeJS.ProcessEnv {
  const forge = req.zones.flatMap((z) => (z.token ? [z.token] : []));
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env, forge),
    CLAUDE_CODE_OAUTH_TOKEN: req.claudeToken,
    [CHAT_MCP_TOKEN_ENV]: req.mcp.token,
  };
  // As the agent, Claude's read-only git must trust the root-made working copies too.
  const gitConfig = as ? agentGitConfigFile() : null;
  if (gitConfig) {
    env.GIT_CONFIG_GLOBAL = gitConfig;
    env.GIT_CONFIG_NOSYSTEM = '1';
  }
  return agentSpawnOptions(as, env).env;
}

export async function* runChatTurn(
  req: ChatTurnRequest,
  signal: AbortSignal,
  deps: ChatTurnDeps = {},
): AsyncIterable<ChatEvent> {
  const spawn = deps.spawn ?? nodeSpawn;
  const root = deps.root ?? DEFAULT_CHAT_REPOS;
  const ids = deps.ids === undefined ? trooperIdentities(process.env) : deps.ids;
  const as = ids?.agent ?? null;
  const sync = deps.sync ?? syncZone;

  const addDirs: string[] = [];
  for (const z of req.zones) {
    if (signal.aborted) return;
    const r = await sync(root, z, as);
    if ('workDir' in r) {
      addDirs.push(r.workDir);
      yield { type: 'zone', zoneId: z.id, state: 'fetched' };
    } else yield { type: 'zone', zoneId: z.id, state: 'unavailable', reason: r.unavailable };
  }
  if (signal.aborted) return;

  const dir = turnDir(as);
  try {
    const systemPromptFile = join(dir, 'system.md');
    writeFileSync(systemPromptFile, systemPrompt(req), { mode: 0o644 });
    const args = buildChatClaudeArgs({
      prompt: req.prompt,
      model: req.model,
      maxTurns: req.maxTurns,
      systemPromptFile,
      resumeSession: req.resumeSession,
      mcpConfigJson: chatMcpConfig(req.mcp.url),
      addDirs,
    });
    // As the agent, start from / and enter <root> after the uid drop.
    const [cmd, ...argv] = asAgentInDirArgv(as, root, ['claude', ...args]) as [string, ...string[]];
    const child = spawn(cmd, argv, {
      cwd: as ? '/' : root,
      env: claudeEnv(req, as),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ended: 'deadline' | 'aborted' | null = null;
    const stop = (why: 'deadline' | 'aborted') => {
      if (ended) return;
      ended = why;
      child.kill('SIGKILL');
      if (as) sweepUid(as.uid);
    };
    const onAbort = () => stop('aborted');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('deadline'), req.deadlineMs);

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-STDERR_TAIL);
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code: number | null) => resolve(code));
    });
    exit.catch(() => undefined);

    let sawResult = false;
    try {
      if (child.stdout) {
        for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          for (const e of eventsOf(line)) {
            if (e.type === 'result') sawResult = true;
            yield e;
          }
        }
      }
      let code: number | null;
      try {
        code = await exit;
      } catch {
        yield { type: 'error', code: 'claude_failed', message: 'Claude could not be started.' };
        return;
      }
      if (ended === 'deadline') {
        yield { type: 'error', code: 'deadline', message: 'The turn ran past its time limit.' };
      } else if (ended === 'aborted') {
        return;
      } else if (code !== 0 && SESSION_LOST.test(stderr)) {
        yield {
          type: 'error',
          code: 'session_lost',
          message: 'Claude no longer has this conversation.',
        };
      } else if (code !== 0 && !sawResult) {
        yield { type: 'error', code: 'claude_failed', message: `Claude exited with code ${code}.` };
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // A consumer that stopped reading early: nothing of the turn may outlive it.
      if (!ended && child.exitCode === null && child.signalCode === null) stop('aborted');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
