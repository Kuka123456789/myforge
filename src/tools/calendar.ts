import type { Env } from '../index';
import { googleFetch, type GoogleAccount } from './google-auth';

interface ListCalendarsInput {
  account?: GoogleAccount;
}

// Discovery: returns every calendar visible to this account, including
// secondary calendars and ones shared by other people (e.g. Oren's/Shira's
// calendars shared into the work account). The id field is what you pass as
// calendar_id to calendar_list_events.
export async function calendarListCalendars(env: Env, input: ListCalendarsInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  url.searchParams.set('minAccessRole', 'reader');
  url.searchParams.set('showHidden', 'true');

  const res = await googleFetch(env, url.toString(), {}, account);
  if (!res.ok) throw new Error(`Calendar list calendars (${account}) failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      summaryOverride?: string;
      description?: string;
      primary?: boolean;
      accessRole?: string;
      timeZone?: string;
      backgroundColor?: string;
    }>;
  };

  return {
    account,
    count: data.items?.length ?? 0,
    calendars: (data.items ?? []).map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary ?? '(no name)',
      primary: Boolean(c.primary),
      access_role: c.accessRole,
      time_zone: c.timeZone,
    })),
  };
}

interface ListEventsInput {
  time_min?: string;
  time_max?: string;
  calendar_id?: string;
  max_results?: number;
  search?: string;
  account?: GoogleAccount;
}

export async function calendarListEvents(env: Env, input: ListEventsInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const calendarId = input.calendar_id ?? 'primary';
  const now = new Date();
  const timeMin = input.time_min ?? now.toISOString();
  const timeMax =
    input.time_max ?? new Date(new Date(timeMin).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(Math.min(input.max_results ?? 20, 50)));
  if (input.search) url.searchParams.set('q', input.search);

  const res = await googleFetch(env, url.toString(), {}, account);
  if (!res.ok) throw new Error(`Calendar list (${account}) failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      description?: string;
      start: { dateTime?: string; date?: string; timeZone?: string };
      end: { dateTime?: string; date?: string };
      location?: string;
      attendees?: Array<{ email: string; responseStatus?: string }>;
      htmlLink?: string;
      hangoutLink?: string;
    }>;
  };

  return {
    account,
    calendar_id: calendarId,
    time_min: timeMin,
    time_max: timeMax,
    count: data.items?.length ?? 0,
    events: (data.items ?? []).map((e) => ({
      id: e.id,
      title: e.summary ?? '(no title)',
      start: e.start.dateTime ?? e.start.date,
      end: e.end.dateTime ?? e.end.date,
      all_day: !e.start.dateTime,
      location: e.location,
      attendees: e.attendees?.map((a) => a.email),
      meet_link: e.hangoutLink,
      link: e.htmlLink,
    })),
  };
}

interface CreateEventInput {
  summary: string;
  start_iso: string;
  end_iso?: string;
  duration_minutes?: number;
  attendees?: string[];
  description?: string;
  location?: string;
  add_meet_link?: boolean;
  calendar_id?: string;
  time_zone?: string;
  account?: GoogleAccount;
}

export async function calendarCreateEvent(env: Env, input: CreateEventInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const calendarId = input.calendar_id ?? 'primary';
  const tz = input.time_zone ?? env.OPERATOR_TIMEZONE ?? 'UTC';

  const start = new Date(input.start_iso);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid start_iso: ${input.start_iso}`);

  let end: Date;
  if (input.end_iso) {
    end = new Date(input.end_iso);
    if (Number.isNaN(end.getTime())) throw new Error(`Invalid end_iso: ${input.end_iso}`);
  } else {
    const minutes = input.duration_minutes ?? 30;
    end = new Date(start.getTime() + minutes * 60 * 1000);
  }

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    attendees: input.attendees?.map((email) => ({ email })),
  };

  if (input.add_meet_link) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set('sendUpdates', input.attendees?.length ? 'all' : 'none');
  if (input.add_meet_link) url.searchParams.set('conferenceDataVersion', '1');

  const res = await googleFetch(
    env,
    url.toString(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    account,
  );

  if (!res.ok) throw new Error(`Calendar create (${account}) failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    id: string;
    htmlLink: string;
    hangoutLink?: string;
  };
  return {
    ok: true,
    account,
    event_id: data.id,
    link: data.htmlLink,
    meet_link: data.hangoutLink,
  };
}

interface DeleteEventInput {
  event_id: string;
  calendar_id?: string;
  account?: GoogleAccount;
}

export async function calendarDeleteEvent(env: Env, input: DeleteEventInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const calendarId = input.calendar_id ?? 'primary';
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.event_id)}?sendUpdates=all`;
  const res = await googleFetch(env, url, { method: 'DELETE' }, account);
  if (res.status === 204) return { ok: true, account, deleted: input.event_id };
  if (!res.ok) throw new Error(`Calendar delete (${account}) failed: ${res.status} ${await res.text()}`);
  return { ok: true, account, deleted: input.event_id };
}
