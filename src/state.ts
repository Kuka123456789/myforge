import type { ClaudeMessage } from './types';

const KEY_PREFIX = 'history:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — old context isn't useful and costs tokens.

export async function loadHistory(kv: KVNamespace, chatId: number): Promise<ClaudeMessage[]> {
  const raw = await kv.get(`${KEY_PREFIX}${chatId}`, 'json');
  if (!raw) return [];
  return raw as ClaudeMessage[];
}

export async function saveHistory(
  kv: KVNamespace,
  chatId: number,
  messages: ClaudeMessage[],
  limit: number,
): Promise<void> {
  // Keep only the last `limit` *user-assistant pairs* worth of messages.
  // Strip large image/document payloads from history — they would balloon KV writes and re-cost
  // tokens on every turn. The assistant's tool_use/tool_result blocks stay so context is intact.
  const trimmed = stripLargeAttachments(messages).slice(-limit * 2);
  await kv.put(`${KEY_PREFIX}${chatId}`, JSON.stringify(trimmed), { expirationTtl: TTL_SECONDS });
}

export async function clearHistory(kv: KVNamespace, chatId: number): Promise<void> {
  await kv.delete(`${KEY_PREFIX}${chatId}`);
}

function stripLargeAttachments(messages: ClaudeMessage[]): ClaudeMessage[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((block) => {
      if (block.type === 'image' || block.type === 'document') {
        return { type: 'text' as const, text: `[${block.type} attachment removed from history]` };
      }
      return block;
    }),
  }));
}
