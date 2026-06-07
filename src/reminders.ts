// Reminder store + scheduled dispatcher.
// One KV key holds the full list — fine for a single-user bot.
// Scheduled handler runs every minute, fires due reminders, removes them.

import { sendMessage } from './telegram';

const KEY = 'reminders:pending';

export interface Reminder {
  id: string;
  chat_id: number;
  when_iso: string; // ISO 8601, UTC
  message: string;
  set_at: string;
}

export async function listReminders(kv: KVNamespace): Promise<Reminder[]> {
  const raw = (await kv.get(KEY, 'json')) as Reminder[] | null;
  return raw ?? [];
}

async function writeReminders(kv: KVNamespace, list: Reminder[]): Promise<void> {
  await kv.put(KEY, JSON.stringify(list));
}

export async function addReminder(
  kv: KVNamespace,
  input: { chat_id: number; when_iso: string; message: string },
): Promise<Reminder> {
  const list = await listReminders(kv);
  const reminder: Reminder = {
    id: crypto.randomUUID().slice(0, 8),
    chat_id: input.chat_id,
    when_iso: new Date(input.when_iso).toISOString(),
    message: input.message,
    set_at: new Date().toISOString(),
  };
  list.push(reminder);
  // Keep sorted by when, ascending — makes the dispatcher's check trivial.
  list.sort((a, b) => a.when_iso.localeCompare(b.when_iso));
  await writeReminders(kv, list);
  return reminder;
}

export async function cancelReminder(kv: KVNamespace, id: string): Promise<boolean> {
  const list = await listReminders(kv);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  await writeReminders(kv, next);
  return true;
}

/**
 * Called every minute by the cron trigger. Fires any reminders due now-ish and
 * removes them from the list. Errors firing one don't block the rest.
 */
export async function fireDueReminders(
  kv: KVNamespace,
  botToken: string,
): Promise<{ fired: number; remaining: number }> {
  const list = await listReminders(kv);
  if (list.length === 0) return { fired: 0, remaining: 0 };

  const nowIso = new Date().toISOString();
  const due = list.filter((r) => r.when_iso <= nowIso);
  const remaining = list.filter((r) => r.when_iso > nowIso);

  for (const r of due) {
    try {
      await sendMessage(botToken, r.chat_id, `⏰ ${r.message}`);
    } catch (err) {
      console.error(`Failed to send reminder ${r.id}:`, err);
      // Drop it anyway — retrying could spam.
    }
  }

  if (due.length > 0) await writeReminders(kv, remaining);

  return { fired: due.length, remaining: remaining.length };
}
