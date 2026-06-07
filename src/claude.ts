import type { Env } from './index';
import { getEffectivePrompt } from './system-prompt';
import { dispatchTool, getToolDefinitions, type ToolContext } from './tools/registry';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
} from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface RunArgs {
  env: Env;
  messages: ClaudeMessage[];
  maxTurns: number;
  chat_id: number;
  /** Called between turns with a one-line status. Fire-and-forget. */
  onProgress?: (text: string) => void;
}

interface RunResult {
  reply: string;
  assistantBlocks: ClaudeContentBlock[];
}

interface ClaudeResponse {
  id: string;
  role: 'assistant';
  content: ClaudeContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export async function runAgent(args: RunArgs): Promise<RunResult> {
  const { env, maxTurns, chat_id, onProgress } = args;
  const messages: ClaudeMessage[] = [...args.messages];
  const tools = getToolDefinitions();
  const toolCtx: ToolContext = { env, chat_id };
  const systemPrompt = await getEffectivePrompt(env.STATE, env.OWNER_CONTEXT);
  let lastAssistant: ClaudeContentBlock[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callClaude(env, messages, tools, systemPrompt);
    lastAssistant = response.content;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      break;
    }

    const toolUses = response.content.filter(
      (b): b is ClaudeToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    // Stage progress to Telegram: one short line listing what's about to run.
    if (onProgress) {
      const summary = toolUses.map(describeToolCall).join(', ');
      onProgress(`🔧 ${summary}…`);
    }

    const toolResults: ClaudeToolResultBlock[] = await Promise.all(
      toolUses.map(async (use) => {
        try {
          const result = await dispatchTool(use.name, use.input, toolCtx);
          return {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          };
        } catch (err) {
          return {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content: err instanceof Error ? err.message : String(err),
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: 'user', content: toolResults });
  }

  const replyText = lastAssistant
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    reply: replyText || 'Done.',
    assistantBlocks: lastAssistant,
  };
}

function describeToolCall(use: ClaudeToolUseBlock): string {
  const input = use.input as Record<string, unknown>;
  switch (use.name) {
    case 'gmail_search_both':
      return `searching both inboxes (${(input.query as string)?.slice(0, 40) ?? ''})`;
    case 'gmail_search':
      return `searching ${input.account ?? 'work'} inbox`;
    case 'gmail_read':
      return `reading email`;
    case 'sheets_read':
      return `reading sheet`;
    case 'sheets_append_expense':
      return `logging expense`;
    case 'drive_upload_invoice':
      return `uploading invoice`;
    case 'calendar_list_events':
      return `checking ${input.account ?? 'work'} calendar`;
    case 'calendar_create_event':
      return `creating ${input.account ?? 'work'} calendar event`;
    case 'calendar_delete_event':
      return `deleting calendar event`;
    case 'reminder_set':
      return `setting reminder`;
    case 'reminder_list':
      return `listing reminders`;
    case 'reminder_cancel':
      return `cancelling reminder`;
    case 'github_code_search':
      return `searching repo code`;
    case 'github_file_get':
      return `reading repo file`;
    case 'github_repo_stats':
      return `getting repo stats`;
    case 'github_issue_search':
      return `searching issues`;
    case 'memory_view':
      return `recalling: ${input.name}`;
    case 'memory_save':
      return `noting: ${input.name}`;
    case 'memory_bulk_save':
      return `noting ${Array.isArray(input.entries) ? input.entries.length : '?'} memories`;
    case 'memory_delete':
      return `forgetting: ${input.name}`;
    default:
      return use.name;
  }
}

async function callClaude(
  env: Env,
  messages: ClaudeMessage[],
  tools: ReturnType<typeof getToolDefinitions>,
  systemPrompt: string,
): Promise<ClaudeResponse> {
  // Server-side tools — Anthropic resolves these without our dispatcher.
  // code_execution: stateful Python sandbox for aggregations, file analysis, math.
  // web_search: current-info lookups (capped at 5 per turn to bound cost).
  const SERVER_TOOLS = [
    { type: 'code_execution_20250825', name: 'code_execution' },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ];

  const userTools = tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
  );

  const body = {
    model: env.CLAUDE_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [...userTools, ...SERVER_TOOLS],
    messages,
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
      'anthropic-beta': 'code-execution-2025-08-25,web-search-2025-03-05',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      throw new Error(
        `Rate-limited by Anthropic (TPM cap). Wait a minute or bump your tier at console.anthropic.com/settings/limits`,
      );
    }
    if (res.status === 529 || res.status === 503) {
      throw new Error('Anthropic is overloaded right now. Try again in a moment.');
    }
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
  }

  return (await res.json()) as ClaudeResponse;
}
