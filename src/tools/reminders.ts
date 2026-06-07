import type { Env } from '../index';
import { addReminder, cancelReminder, listReminders } from '../reminders';

interface SetInput {
  when_iso: string; // ISO 8601 in UTC
  message: string;
  chat_id: number;
}

export async function reminderSet(env: Env, input: SetInput): Promise<unknown> {
  const when = new Date(input.when_iso);
  if (Number.isNaN(when.getTime())) {
    return { error: `Invalid when_iso: ${input.when_iso}. Use ISO 8601 with timezone, e.g. 2026-06-07T09:00:00+01:00` };
  }
  if (when.getTime() < Date.now() - 60_000) {
    return { error: 'when_iso is in the past' };
  }
  const reminder = await addReminder(env.STATE, {
    chat_id: input.chat_id,
    when_iso: input.when_iso,
    message: input.message,
  });
  return {
    ok: true,
    id: reminder.id,
    fires_at: reminder.when_iso,
    message: reminder.message,
  };
}

export async function reminderList(env: Env): Promise<unknown> {
  const list = await listReminders(env.STATE);
  return {
    count: list.length,
    reminders: list.map((r) => ({
      id: r.id,
      when_iso: r.when_iso,
      message: r.message,
    })),
  };
}

export async function reminderCancel(env: Env, id: string): Promise<unknown> {
  const ok = await cancelReminder(env.STATE, id);
  return ok ? { ok: true, deleted: id } : { error: `No reminder with id "${id}"` };
}
