import type { Env } from '../index';
import { deleteEntry, getEntry, saveEntry, type MemoryType } from '../memory';

export async function memoryView(env: Env, name: string): Promise<unknown> {
  const entry = await getEntry(env.STATE, name);
  if (!entry) return { error: `No memory named "${name}"` };
  return entry;
}

export async function memorySave(
  env: Env,
  input: { name: string; description: string; type: MemoryType; content: string },
): Promise<unknown> {
  const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  if (!VALID_TYPES.includes(input.type)) {
    return { error: `Invalid type "${input.type}". Must be one of: ${VALID_TYPES.join(', ')}` };
  }
  if (!input.name?.trim()) return { error: 'name is required' };
  if (!input.description?.trim()) return { error: 'description is required' };
  if (!input.content?.trim()) return { error: 'content is required' };

  const entry = await saveEntry(env.STATE, input);
  return {
    ok: true,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    updated_at: entry.updated_at,
  };
}

export async function memoryBulkSave(
  env: Env,
  input: {
    entries: Array<{ name: string; description: string; type: MemoryType; content: string }>;
  },
): Promise<unknown> {
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    return { error: 'entries must be a non-empty array' };
  }
  const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  const saved: Array<{ name: string; description: string; type: MemoryType }> = [];
  const errors: Array<{ name?: string; reason: string }> = [];

  for (const entry of input.entries) {
    try {
      if (!VALID_TYPES.includes(entry.type)) {
        errors.push({ name: entry.name, reason: `invalid type "${entry.type}"` });
        continue;
      }
      if (!entry.name?.trim() || !entry.description?.trim() || !entry.content?.trim()) {
        errors.push({ name: entry.name, reason: 'missing required field' });
        continue;
      }
      const result = await saveEntry(env.STATE, entry);
      saved.push({ name: result.name, description: result.description, type: result.type });
    } catch (err) {
      errors.push({
        name: entry.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, saved_count: saved.length, error_count: errors.length, saved, errors };
}

export async function memoryDelete(env: Env, name: string): Promise<unknown> {
  const existed = await deleteEntry(env.STATE, name);
  return existed ? { ok: true, deleted: name } : { error: `No memory named "${name}"` };
}
