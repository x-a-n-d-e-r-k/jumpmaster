// The argv of one chat turn's `claude` process. Its tools read the zones' clones and call the
// jumpmaster MCP server, nothing else: no writes, no web, no sub-agents, no other MCP server.

/** Reading the clones (files and read-only git) and the jumpmaster MCP tools. */
export const CHAT_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git blame:*)',
  'Bash(git grep:*)',
  'mcp__jumpmaster__*',
].join(',');

export const CHAT_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
].join(',');

/** The environment variable Claude Code expands into the MCP bearer header. */
export const CHAT_MCP_TOKEN_ENV = 'JM_CHAT_MCP_TOKEN';

/**
 * The MCP config naming the server's chat endpoint. The bearer token is `${JM_CHAT_MCP_TOKEN}`,
 * expanded by Claude Code from its environment, so the token never sits in argv.
 */
export function chatMcpConfig(url: string): string {
  return JSON.stringify({
    mcpServers: {
      jumpmaster: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer \${${CHAT_MCP_TOKEN_ENV}}` },
      },
    },
  });
}

export function buildChatClaudeArgs(o: {
  prompt: string;
  model: string;
  maxTurns: number;
  systemPromptFile: string;
  resumeSession: string | null;
  mcpConfigJson: string;
  addDirs: string[];
}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model,
    '--max-turns',
    String(o.maxTurns),
    '--append-system-prompt-file',
    o.systemPromptFile,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    o.mcpConfigJson,
    '--allowedTools',
    CHAT_ALLOWED_TOOLS,
    '--disallowedTools',
    CHAT_DISALLOWED_TOOLS,
    ...(o.resumeSession !== null ? ['--resume', o.resumeSession] : []),
    ...o.addDirs.flatMap((d) => ['--add-dir', d]),
    // After `--`, so neither a prompt that starts with `-` nor the variadic `--add-dir` can
    // read it as an option.
    '--',
    o.prompt,
  ];
}
