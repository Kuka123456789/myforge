import type { Env } from './index';
import type { ClaudeMessage } from './types';

// Long-term chat archive in R2. The hot-context KV history caps at ~12 turns;
// this captures everything for later retrieval. One JSONL file per chat per day:
//   chat-{chatId}/{YYYY-MM-DD}.jsonl
// Each line is an ArchivedTurn (see below). We strip attachment bytes and
// truncate tool_result payloads so the file stays small enough for repeat
// read-modify-write without paging.

const MAX_TOOL_RESULT_CHARS = 800; // enough to be useful in search, small enough to keep file lean

interface ArchivedTurn {
  ts: string; // ISO
  role: 'user' | 'assistant';
  text: string; // concatenated text blocks
  tool_calls?: Array<{ name: string; input_summary?: string }>; // assistant tool_use names
  tool_results?: Array<{ tool_use_id: string; preview: string; is_error?: boolean }>;
  attachments?: Array<{ kind: 'image' | 'document' }>; // hints, not bytes
}

export async function appendTurns(
  env: Env,
  chatId: number,
  messages: ClaudeMessage[],
): Promise<void> {
  if (!env.TRANSCRIPTS) return; // binding not configured yet — silent no-op
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const key = transcriptKey(chatId, dateKey);

  const turns = messages
    .map((m) => archiveTurn(m, now))
    .filter((t): t is ArchivedTurn => t !== null);
  if (turns.length === 0) return;

  // R2 has no native append. Read existing, concat, put back. The daily file
  // for a single chat stays well under 1 MB even on heavy days.
  const existing = await env.TRANSCRIPTS.get(key);
  const existingText = existing ? await existing.text() : '';
  const newText = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';

  await env.TRANSCRIPTS.put(key, existingText + newText, {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });
}

interface SearchInput {
  chat_id: number;
  query: string;
  days_back?: number; // default 30
  max_results?: number; // default 20
}

export async function searchTranscripts(env: Env, input: SearchInput): Promise<unknown> {
  if (!env.TRANSCRIPTS) {
    return { error: "Archive not configured (TRANSCRIPTS R2 binding missing). Operator hasn't created the R2 bucket yet." };
  }
  const daysBack = Math.max(1, Math.min(input.days_back ?? 30, 365));
  const maxResults = Math.max(1, Math.min(input.max_results ?? 20, 100));
  const needle = input.query.toLowerCase();
  if (!needle) return { error: 'query is required' };

  const dates = lastNDates(daysBack);
  const matches: Array<{ date: string; ts: string; role: string; text: string; tool_calls?: string[] }> = [];

  for (const date of dates) {
    const obj = await env.TRANSCRIPTS.get(transcriptKey(input.chat_id, date));
    if (!obj) continue;
    const text = await obj.text();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let turn: ArchivedTurn;
      try {
        turn = JSON.parse(line) as ArchivedTurn;
      } catch {
        continue;
      }
      const haystack = [
        turn.text,
        ...(turn.tool_calls ?? []).map((c) => `${c.name} ${c.input_summary ?? ''}`),
        ...(turn.tool_results ?? []).map((r) => r.preview),
      ]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({
          date,
          ts: turn.ts,
          role: turn.role,
          text: turn.text.slice(0, 500),
          tool_calls: turn.tool_calls?.map((c) => c.name),
        });
        if (matches.length >= maxResults) break;
      }
    }
    if (matches.length >= maxResults) break;
  }

  return {
    query: input.query,
    days_back: daysBack,
    count: matches.length,
    matches,
    truncated: matches.length >= maxResults,
  };
}

interface RangeInput {
  chat_id: number;
  from_date: string; // YYYY-MM-DD inclusive
  to_date?: string; // YYYY-MM-DD inclusive, defaults to from_date
  max_turns?: number; // default 100
}

export async function readTranscriptRange(env: Env, input: RangeInput): Promise<unknown> {
  if (!env.TRANSCRIPTS) {
    return { error: "Archive not configured (TRANSCRIPTS R2 binding missing)." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from_date)) {
    return { error: 'from_date must be YYYY-MM-DD' };
  }
  const toDate = input.to_date ?? input.from_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { error: 'to_date must be YYYY-MM-DD' };
  }
  const maxTurns = Math.max(1, Math.min(input.max_turns ?? 100, 500));

  const dates = datesBetween(input.from_date, toDate);
  if (dates.length > 60) {
    return { error: `Date range too wide (${dates.length} days). Cap is 60.` };
  }

  const turns: ArchivedTurn[] = [];
  for (const date of dates) {
    const obj = await env.TRANSCRIPTS.get(transcriptKey(input.chat_id, date));
    if (!obj) continue;
    const text = await obj.text();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        turns.push(JSON.parse(line) as ArchivedTurn);
        if (turns.length >= maxTurns) break;
      } catch {
        // skip malformed lines
      }
    }
    if (turns.length >= maxTurns) break;
  }

  return {
    from_date: input.from_date,
    to_date: toDate,
    count: turns.length,
    truncated: turns.length >= maxTurns,
    turns,
  };
}

function transcriptKey(chatId: number, dateKey: string): string {
  return `chat-${chatId}/${dateKey}.jsonl`;
}

function lastNDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out; // newest first
}

function datesBetween(from: string, to: string): string[] {
  const start = new Date(from + 'T00:00:00Z').getTime();
  const end = new Date(to + 'T00:00:00Z').getTime();
  const out: string[] = [];
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function archiveTurn(m: ClaudeMessage, ts: Date): ArchivedTurn | null {
  const turn: ArchivedTurn = { ts: ts.toISOString(), role: m.role, text: '' };
  const textParts: string[] = [];
  const toolCalls: ArchivedTurn['tool_calls'] = [];
  const toolResults: ArchivedTurn['tool_results'] = [];
  const attachments: ArchivedTurn['attachments'] = [];

  for (const block of m.content) {
    const b = block as unknown as { type: string } & Record<string, unknown>;
    if (b.type === 'text') {
      const t = (b.text as string) ?? '';
      // Skip the per-turn preface — it's noise in the archive.
      if (t.trimStart().startsWith('<today>')) continue;
      textParts.push(t);
    } else if (b.type === 'image') {
      attachments.push({ kind: 'image' });
    } else if (b.type === 'document') {
      attachments.push({ kind: 'document' });
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        name: String(b.name),
        input_summary: JSON.stringify(b.input).slice(0, 200),
      });
    } else if (b.type === 'server_tool_use') {
      toolCalls.push({ name: String(b.name), input_summary: JSON.stringify(b.input).slice(0, 200) });
    } else if (b.type === 'tool_result') {
      const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      toolResults.push({
        tool_use_id: String(b.tool_use_id),
        preview: content.slice(0, MAX_TOOL_RESULT_CHARS),
        is_error: Boolean(b.is_error),
      });
    } else if (b.type === 'web_search_tool_result') {
      const content = JSON.stringify(b.content);
      toolResults.push({
        tool_use_id: String(b.tool_use_id),
        preview: content.slice(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  turn.text = textParts.join('\n').trim();
  if (toolCalls.length > 0) turn.tool_calls = toolCalls;
  if (toolResults.length > 0) turn.tool_results = toolResults;
  if (attachments.length > 0) turn.attachments = attachments;

  // Skip turns with literally nothing to archive (shouldn't normally happen).
  if (!turn.text && !turn.tool_calls && !turn.tool_results && !turn.attachments) {
    return null;
  }
  return turn;
}
