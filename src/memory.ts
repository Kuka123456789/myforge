// Long-term memory store. KV-backed. Persists across conversations and chats.
//
// Two key spaces:
//   mem:<slug>     → individual memory entry (JSON)
//   mem:_index     → array of { name, description, type } for fast scanning
//
// The index is loaded on every turn and prepended to the user message so Claude
// always knows what's stored without making an extra tool call.

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  updated_at: string;
}

export interface IndexEntry {
  name: string;
  description: string;
  type: MemoryType;
}

const INDEX_KEY = 'mem:_index';
const SLUG_PREFIX = 'mem:';

function entryKey(name: string): string {
  return `${SLUG_PREFIX}${name}`;
}

function sanitiseName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

export async function loadIndex(kv: KVNamespace): Promise<IndexEntry[]> {
  const raw = (await kv.get(INDEX_KEY, 'json')) as IndexEntry[] | null;
  return raw ?? [];
}

async function saveIndex(kv: KVNamespace, index: IndexEntry[]): Promise<void> {
  await kv.put(INDEX_KEY, JSON.stringify(index));
}

export async function getEntry(kv: KVNamespace, rawName: string): Promise<MemoryEntry | null> {
  const name = sanitiseName(rawName);
  if (!name) return null;
  return (await kv.get(entryKey(name), 'json')) as MemoryEntry | null;
}

export async function saveEntry(
  kv: KVNamespace,
  input: { name: string; description: string; type: MemoryType; content: string },
): Promise<MemoryEntry> {
  const name = sanitiseName(input.name);
  if (!name) throw new Error('Memory name must be non-empty after sanitisation');

  const entry: MemoryEntry = {
    name,
    description: input.description.trim(),
    type: input.type,
    content: input.content.trim(),
    updated_at: new Date().toISOString(),
  };

  await kv.put(entryKey(name), JSON.stringify(entry));

  // Sync the index — replace any prior entry with the same name, keep order otherwise.
  const index = await loadIndex(kv);
  const existing = index.findIndex((e) => e.name === name);
  const summary: IndexEntry = { name, description: entry.description, type: entry.type };
  if (existing >= 0) index[existing] = summary;
  else index.push(summary);
  await saveIndex(kv, index);

  return entry;
}

export async function deleteEntry(kv: KVNamespace, rawName: string): Promise<boolean> {
  const name = sanitiseName(rawName);
  if (!name) return false;
  const existed = (await kv.get(entryKey(name))) !== null;
  await kv.delete(entryKey(name));
  const index = (await loadIndex(kv)).filter((e) => e.name !== name);
  await saveIndex(kv, index);
  return existed;
}

/**
 * Renders the index as a compact text block to prepend to each user message.
 * Returns an empty string if no memories exist (so the bot doesn't get a
 * confusing empty marker on its first ever conversation).
 */
export function renderIndexAsContext(index: IndexEntry[]): string {
  if (index.length === 0) return '';
  const byType: Record<MemoryType, IndexEntry[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: [],
  };
  for (const entry of index) byType[entry.type].push(entry);

  const lines: string[] = ['<memory-index>'];
  for (const type of ['user', 'feedback', 'project', 'reference'] as MemoryType[]) {
    if (byType[type].length === 0) continue;
    lines.push(`## ${type}`);
    for (const entry of byType[type]) {
      lines.push(`- [${entry.name}] ${entry.description}`);
    }
  }
  lines.push('</memory-index>');
  return lines.join('\n');
}
