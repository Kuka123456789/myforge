import type { ClaudeMessage } from './types';

const KEY_PREFIX = 'history:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — old context isn't useful and costs tokens.

export async function loadHistory(kv: KVNamespace, chatId: number): Promise<ClaudeMessage[]> {
  const raw = await kv.get(`${KEY_PREFIX}${chatId}`, 'json');
  if (!raw) return [];
  // Self-heal: prior versions of saveHistory could persist sliced histories
  // with orphaned tool_use / tool_result blocks. Repair on load so existing
  // broken entries don't keep failing.
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
  // Finally repair tool pairs — slicing can orphan a tool call from its result (Anthropic 400s).
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

// Block-shape classifiers. The Anthropic API pairs every tool call with its result
// by id, and this holds structurally across ALL tool families: client tools
// (tool_use -> tool_result) and every server tool (server_tool_use ->
// web_search_tool_result / code_execution_tool_result / bash_code_execution_tool_result / ...).
// Rather than enumerate result-block type names (which grow every time a new server
// tool ships), detect by shape: a PRODUCER is a tool_use/server_tool_use (carries
// `id`); a CONSUMER is any block carrying a `tool_use_id`. New tools need no change.
type AnyBlock = { type: string; id?: string; tool_use_id?: string };
const isProducer = (b: AnyBlock): boolean =>
  b.type === 'tool_use' || b.type === 'server_tool_use';
const isConsumer = (b: AnyBlock): boolean => typeof b.tool_use_id === 'string';

// Enforces the two dual invariants the API checks, so a sliced/truncated history
// never 400s on a dangling tool call or result:
//   forward  - every surviving CONSUMER references a producer seen earlier
//              (drops an orphan *_tool_result whose producer was sliced off)
//   backward - every surviving PRODUCER is referenced by some surviving consumer
//              (drops an unanswered client tool_use cut off by MAX_TURNS, AND a
//               server_tool_use whose result never came, e.g. a pause_turn)
// Also trims leading messages until the first kept one is a user message with no
// orphan consumer (the conversation must begin with user, and a consumer there has
// no preceding producer to satisfy it).
function repairToolPairs(messages: ClaudeMessage[]): ClaudeMessage[] {
  // 1. Find the first viable start: a user message with no consumer blocks.
  let start = 0;
  while (start < messages.length) {
    const m = messages[start];
    if (m.role === 'user' && !m.content.some((b) => isConsumer(b as AnyBlock))) break;
    start++;
  }
  if (start >= messages.length) return [];

  // 2. Forward: drop any consumer whose producer wasn't seen earlier in the
  // window. Producers are added to `produced` in array order, so a server tool's
  // same-message result (which follows its producer) resolves correctly.
  const produced = new Set<string>();
  const out: ClaudeMessage[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    const cleaned = m.content.filter((b) => {
      const block = b as AnyBlock;
      if (isProducer(block)) {
        if (block.id) produced.add(block.id);
        return true;
      }
      if (isConsumer(block)) return produced.has(block.tool_use_id as string);
      return true;
    });
    if (cleaned.length > 0) out.push({ ...m, content: cleaned });
  }

  // 3. Backward: drop any producer not referenced by a surviving consumer. This
  // is the dual of step 2 and covers both an unanswered client tool_use and an
  // orphaned server_tool_use uniformly, with no per-tool special-casing.
  const referenced = new Set<string>();
  for (const m of out) {
    for (const b of m.content) {
      const block = b as AnyBlock;
      if (isConsumer(block)) referenced.add(block.tool_use_id as string);
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = {
      ...out[i],
      content: out[i].content.filter((b) => {
        const block = b as AnyBlock;
        return isProducer(block) ? Boolean(block.id && referenced.has(block.id)) : true;
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
