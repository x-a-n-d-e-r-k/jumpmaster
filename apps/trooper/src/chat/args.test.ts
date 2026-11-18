import { describe, expect, test } from 'vitest';
import { buildChatClaudeArgs, chatMcpConfig } from './args.js';

const base = {
  prompt: 'what is open?',
  model: 'claude-opus-5-5',
  maxTurns: 20,
  systemPromptFile: '/tmp/jm-chat-x/system.md',
  resumeSession: null as string | null,
  mcpConfigJson: chatMcpConfig('http://jumpmaster:7420/mcp/chat'),
  addDirs: ['/chat/repos/main/work', '/chat/repos/web/work'],
};

const valueOf = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('buildChatClaudeArgs', () => {
  test('buildChatClaudeArgs limits tools to reading and the jumpmaster MCP server', () => {
    const args = buildChatClaudeArgs(base);
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--strict-mcp-config');
    expect(valueOf(args, '--allowedTools')).toBe(
      'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git blame:*),Bash(git grep:*),mcp__jumpmaster__*',
    );
    expect(valueOf(args, '--disallowedTools')).toBe(
      'Write,Edit,NotebookEdit,WebFetch,WebSearch,Task',
    );
    expect(valueOf(args, '--mcp-config')).toBe(base.mcpConfigJson);
    expect(valueOf(args, '--append-system-prompt-file')).toBe(base.systemPromptFile);
    expect(valueOf(args, '--model')).toBe('claude-opus-5-5');
    expect(valueOf(args, '--max-turns')).toBe('20');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args).not.toContain('--resume');

    const resumed = buildChatClaudeArgs({ ...base, resumeSession: 'sess-1' });
    expect(valueOf(resumed, '--resume')).toBe('sess-1');

    for (const a of [...args, ...resumed]) {
      expect(a).not.toContain('bypassPermissions');
      expect(a).not.toContain('jmm_');
    }
  });

  test('chatMcpConfig takes the bearer token from the environment, never a value', () => {
    expect(JSON.parse(chatMcpConfig('http://jumpmaster:7420/mcp/chat'))).toEqual({
      mcpServers: {
        jumpmaster: {
          type: 'http',
          url: 'http://jumpmaster:7420/mcp/chat',
          headers: { Authorization: 'Bearer ${JM_CHAT_MCP_TOKEN}' },
        },
      },
    });
  });
});
