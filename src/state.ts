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
  // tokens on every turn. Also strip the per-turn preface (<today> + any legacy <memory-index>)
  // since those are re-injected on each new call from live state and the system prompt; keeping
  // them in history meant the memory index was being billed 10+ times per multi-turn message.
  const trimmed = stripPreface(stripLargeAttachments(messages)).slice(-limit * 2);
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

function stripPreface(messages: ClaudeMessage[]): ClaudeMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user') return m;
    const filtered = m.content.filter((block) => {
      if (block.type !== 'text') return true;
      const t = block.text.trimStart();
      // Drop the preface block (<today> alone, or combined <today>+<memory-index>
      // from older saves) — they're rebuilt fresh each call.
      return !(t.startsWith('<today>') || t.startsWith('<memory-index>'));
    });
    return { ...m, content: filtered };
  });
}
