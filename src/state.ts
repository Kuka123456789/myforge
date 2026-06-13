import type { ClaudeMessage } from './types';

const KEY_PREFIX = 'history:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — old context isn't useful and costs tokens.

export async function loadHistory(kv: KVNamespace, chatId: number): Promise<ClaudeMessage[]> {
  const raw = await kv.get(`${KEY_PREFIX}${chatId}`, 'json');
  if (!raw) return [];
  // Self-heal: prior versions of saveHistory could persist sliced histories
  // with orphaned tool_result / web_search_tool_result blocks. Repair on load
  // so existing broken entries don't keep failing.
  return repairToolPairs(raw as ClaudeMessage[]);
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
  // Finally repair tool pairs — slicing can orphan tool_result / web_search_tool_result
  // blocks from their preceding tool_use / server_tool_use producer (Anthropic 400s on that).
  const trimmed = repairToolPairs(
    stripPreface(stripLargeAttachments(messages)).slice(-limit * 2),
  );
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

// Drops content blocks whose preceding producer is missing from the window:
//   - tool_result needs a prior tool_use with the same id
//   - web_search_tool_result needs a prior server_tool_use with the same id
// Also trims leading messages until the first kept message is a user message
// that doesn't start with an orphan tool_result — Anthropic requires the
// conversation to begin with user, and a tool_result block at index 0 has no
// preceding producer to satisfy it.
function repairToolPairs(messages: ClaudeMessage[]): ClaudeMessage[] {
  // 1. Find the first viable start: a user message whose content has no
  // tool_result blocks (they'd need a producer that we no longer have).
  let start = 0;
  while (start < messages.length) {
    const m = messages[start];
    const hasOrphanShaped = m.content.some((b) => {
      const t = (b as { type: string }).type;
      return t === 'tool_result' || t === 'web_search_tool_result';
    });
    if (m.role === 'user' && !hasOrphanShaped) break;
    start++;
  }
  if (start >= messages.length) return [];

  // 2. Walk forward, building a producers set; drop any consumer block
  // whose producer wasn't seen in the kept window. Drop messages that
  // become empty as a result.
  const produced = new Set<string>();
  const out: ClaudeMessage[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    const cleaned = m.content.filter((b) => {
      const block = b as { type: string; id?: string; tool_use_id?: string };
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        if (block.id) produced.add(block.id);
        return true;
      }
      if (block.type === 'tool_result' || block.type === 'web_search_tool_result') {
        return Boolean(block.tool_use_id && produced.has(block.tool_use_id));
      }
      return true;
    });
    if (cleaned.length > 0) {
      out.push({ ...m, content: cleaned });
    }
  }

  // 3. Reverse direction: client-side tool_use blocks REQUIRE a following user
  // message with matching tool_result. If MAX_TURNS hits mid-loop, the saved
  // history ends on an assistant turn whose tool_use blocks were never answered.
  // Anthropic 400s on the next call with "tool_use ids were found without
  // tool_result blocks immediately after". For each assistant message, check
  // the next message's tool_result ids; drop any tool_use blocks not answered.
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== 'assistant') continue;
    const next = out[i + 1];
    const answered = new Set<string>();
    if (next && next.role === 'user') {
      for (const b of next.content) {
        const block = b as { type: string; tool_use_id?: string };
        if (block.type === 'tool_result' && block.tool_use_id) {
          answered.add(block.tool_use_id);
        }
      }
    }
    out[i] = {
      ...out[i],
      content: out[i].content.filter((b) => {
        const block = b as { type: string; id?: string };
        if (block.type !== 'tool_use') return true;
        return Boolean(block.id && answered.has(block.id));
      }),
    };
  }
  return out.filter((m) => m.content.length > 0);
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
