// Anthropic Messages API content blocks (subset we use).

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ClaudeImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface ClaudeDocumentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeDocumentBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: ClaudeContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
