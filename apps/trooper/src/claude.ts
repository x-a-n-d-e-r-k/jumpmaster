export interface ClaudeArgsOptions {
  prompt: string;
  model: string;
  maxTurns: number;
  systemPromptFile: string;
  settingsFile: string;
  /** JSON schema for the structured result (implement, review, …). */
  outputSchema: object;
}

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  return [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model,
    '--max-turns',
    String(o.maxTurns),
    '--append-system-prompt-file',
    o.systemPromptFile,
    '--settings',
    o.settingsFile,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'bypassPermissions',
    '--json-schema',
    JSON.stringify(o.outputSchema),
  ];
}

export type ParsedLine =
  | {
      type: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      resetsAt?: string;
      rateLimitType?: string;
      unifiedWindows?: Partial<Record<'five_hour' | 'seven_day', UsageWindow>>;
      raw: unknown;
    }
  | { type: 'init'; sessionId: string }
  | {
      type: 'result';
      isError: boolean;
      structured?: unknown;
      usage?: unknown;
      modelUsage?: unknown;
      numTurns?: number;
      terminalReason?: string;
      sessionId?: string;
    }
  | { type: 'agent'; raw: unknown }
  | { type: 'ignored' };

export type UsageWindow = { utilization: number; resetsAt?: string };

function windowsOf(
  v: unknown,
): Partial<Record<'five_hour' | 'seven_day', UsageWindow>> | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const out: Partial<Record<'five_hour' | 'seven_day', UsageWindow>> = {};
  for (const key of ['five_hour', 'seven_day'] as const) {
    const w = (v as Record<string, Record<string, unknown> | undefined>)[key];
    if (!w || typeof w.utilization !== 'number') continue;
    const resetsAt = normalizeResetsAt(w.resetsAt ?? w.resets_at);
    out[key] = { utilization: w.utilization, ...(resetsAt ? { resetsAt } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeResetsAt(v: unknown): string | undefined {
  let d: Date;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === 'string' && v !== '') d = new Date(v);
  else return undefined;
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

export function parseStreamLine(line: string): ParsedLine {
  if (line.trim() === '') return { type: 'ignored' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: 'ignored' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { type: 'ignored' };
  const m = raw as Record<string, unknown>;
  if (m.type === 'rate_limit_event') {
    const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
    const status = info.status;
    if (status === 'allowed' || status === 'allowed_warning' || status === 'rejected') {
      const resetsAt = normalizeResetsAt(info.resetsAt);
      const unifiedWindows = windowsOf(info.unifiedWindows);
      return {
        type: 'rate_limit',
        status,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(typeof info.rateLimitType === 'string' ? { rateLimitType: info.rateLimitType } : {}),
        ...(unifiedWindows ? { unifiedWindows } : {}),
        raw,
      };
    }
    return { type: 'agent', raw };
  }
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return { type: 'init', sessionId: m.session_id };
  }
  if (m.type === 'result') {
    return {
      type: 'result',
      isError: m.is_error === true,
      structured: m.structured_output,
      usage: m.usage,
      modelUsage: m.modelUsage,
      numTurns: typeof m.num_turns === 'number' ? m.num_turns : undefined,
      terminalReason: typeof m.terminal_reason === 'string' ? m.terminal_reason : undefined,
      sessionId: typeof m.session_id === 'string' ? m.session_id : undefined,
    };
  }
  return { type: 'agent', raw };
}
