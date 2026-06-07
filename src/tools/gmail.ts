import type { Env } from '../index';
import { googleFetch, type GoogleAccount } from './google-auth';

interface GmailMessage {
  id: string;
  threadId: string;
}

interface GmailMessageDetail {
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    parts?: Array<{ mimeType: string; body: { data?: string; size: number } }>;
    body?: { data?: string };
    mimeType: string;
  };
  internalDate: string;
}

export async function gmailSearch(
  env: Env,
  query: string,
  maxResults: number,
  account: GoogleAccount = 'work',
): Promise<unknown> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(Math.min(maxResults, 20)));

  const res = await googleFetch(env, url.toString(), {}, account);
  if (!res.ok) throw new Error(`Gmail search (${account}) failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { messages?: GmailMessage[]; resultSizeEstimate?: number };
  const messages = data.messages ?? [];
  console.log(`[gmail_search] account=${account} query="${query}" → ${messages.length} returned, estimate ${data.resultSizeEstimate ?? '?'}`);

  const details = await Promise.all(
    messages.map(async (m) => fetchSummary(env, m.id, account)),
  );

  return {
    account,
    query,
    count: details.length,
    messages: details,
  };
}

/**
 * Search both work and personal in parallel and merge results.
 * Use when the user asks about email without specifying an account.
 */
export async function gmailSearchBoth(
  env: Env,
  query: string,
  maxResults: number,
): Promise<unknown> {
  const [work, personal] = await Promise.allSettled([
    gmailSearch(env, query, maxResults, 'work'),
    gmailSearch(env, query, maxResults, 'personal'),
  ]);
  return {
    query,
    work: work.status === 'fulfilled' ? work.value : { error: String(work.reason) },
    personal: personal.status === 'fulfilled' ? personal.value : { error: String(personal.reason) },
  };
}

export async function gmailRead(
  env: Env,
  messageId: string,
  account: GoogleAccount = 'work',
): Promise<unknown> {
  const res = await googleFetch(
    env,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    {},
    account,
  );
  if (!res.ok) throw new Error(`Gmail read (${account}) failed: ${res.status} ${await res.text()}`);

  const msg = (await res.json()) as GmailMessageDetail;
  const headers = msg.payload.headers;
  const get = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const body = extractTextBody(msg);

  return {
    account,
    id: msg.id,
    thread_id: msg.threadId,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    snippet: msg.snippet,
    body: body.slice(0, 6000),
    body_truncated: body.length > 6000,
    link: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
  };
}

async function fetchSummary(env: Env, messageId: string, account: GoogleAccount) {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
  );
  url.searchParams.set('format', 'metadata');
  url.searchParams.append('metadataHeaders', 'From');
  url.searchParams.append('metadataHeaders', 'Subject');
  url.searchParams.append('metadataHeaders', 'Date');

  const res = await googleFetch(env, url.toString(), {}, account);
  if (!res.ok) return { id: messageId, error: `metadata fetch failed ${res.status}` };

  const msg = (await res.json()) as GmailMessageDetail;
  const get = (name: string) =>
    msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  return {
    id: msg.id,
    thread_id: msg.threadId,
    from: get('From'),
    subject: get('Subject'),
    date: get('Date'),
    snippet: msg.snippet,
    link: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
  };
}

function extractTextBody(msg: GmailMessageDetail): string {
  // Walk parts looking for text/plain first, then text/html.
  const findPart = (mime: string) => {
    if (msg.payload.mimeType === mime && msg.payload.body?.data) return msg.payload.body.data;
    if (!msg.payload.parts) return null;
    for (const part of msg.payload.parts) {
      if (part.mimeType === mime && part.body.data) return part.body.data;
    }
    return null;
  };

  const plain = findPart('text/plain');
  if (plain) return decodeBase64Url(plain);

  const html = findPart('text/html');
  if (html) return stripHtml(decodeBase64Url(html));

  return msg.snippet;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
