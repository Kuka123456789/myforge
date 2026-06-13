import type { Env } from '../index';
import { googleFetch, type GoogleAccount } from './google-auth';

interface GmailMessage {
  id: string;
  threadId: string;
}

// A MIME part. Gmail nests these arbitrarily deep (multipart/mixed →
// multipart/alternative → text/plain), so `parts` is recursive.
interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessageDetail {
  id: string;
  threadId: string;
  snippet: string;
  payload: GmailPart & { headers: Array<{ name: string; value: string }> };
  internalDate: string;
}

export interface GmailAttachment {
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string;
}

const BODY_CAP = 20000;

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
  offset = 0,
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

  const { body, attachments } = walkPayload(msg);
  const start = Math.max(0, offset);
  const slice = body.slice(start, start + BODY_CAP);
  const nextOffset = start + slice.length;

  return {
    account,
    id: msg.id,
    thread_id: msg.threadId,
    from: get('From'),
    to: get('To'),
    cc: get('Cc') || undefined,
    subject: get('Subject'),
    date: get('Date'),
    snippet: msg.snippet,
    body: slice,
    body_length: body.length,
    body_offset: start,
    // True when more body remains past this slice. To read it, call gmail_read
    // again with offset=next_offset.
    body_truncated: nextOffset < body.length,
    next_offset: nextOffset < body.length ? nextOffset : undefined,
    attachments,
    // Hint so the model knows it can pull attachment content.
    attachments_note: attachments.length
      ? 'Use gmail_get_attachment with this message_id + attachment_id to read a text-based attachment.'
      : undefined,
    link: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
  };
}

/**
 * Fetch a single attachment's content. Text-like attachments (text/*, csv,
 * json, xml, calendar) are decoded and returned inline (capped). Binary types
 * (PDF, images, office docs) can't be inlined as a tool result here, so we
 * return their metadata only — surface the Gmail link and offer to save to
 * Drive if the operator needs the file itself.
 */
export async function gmailGetAttachment(
  env: Env,
  messageId: string,
  attachmentId: string,
  account: GoogleAccount = 'work',
  filename = '',
  mimeType = '',
): Promise<unknown> {
  const res = await googleFetch(
    env,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    {},
    account,
  );
  if (!res.ok)
    throw new Error(`Gmail attachment (${account}) failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { data?: string; size?: number };
  const size = data.size ?? 0;

  if (!isTextMime(mimeType, filename)) {
    return {
      account,
      message_id: messageId,
      attachment_id: attachmentId,
      filename,
      mime_type: mimeType,
      size,
      content: null,
      note: `Binary attachment (${mimeType || 'unknown type'}); content can't be inlined. Open it in Gmail, or ask to save it to Drive.`,
    };
  }

  const text = data.data ? decodeBase64Url(data.data) : '';
  return {
    account,
    message_id: messageId,
    attachment_id: attachmentId,
    filename,
    mime_type: mimeType,
    size,
    content: text.slice(0, BODY_CAP),
    content_truncated: text.length > BODY_CAP,
  };
}

function isTextMime(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith('text/')) return true;
  if (/(json|csv|xml|calendar|x-yaml|yaml|markdown)/.test(m)) return true;
  // Fall back to extension when Gmail reports application/octet-stream.
  return /\.(txt|csv|tsv|json|xml|md|yaml|yml|ics|log|ini|conf)$/i.test(filename);
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

/**
 * Recursively walk the MIME tree collecting (a) the best text body and (b)
 * every attachment. Gmail nests body text inside multipart/alternative inside
 * multipart/mixed whenever there's an attachment, so a one-level scan misses
 * both the body AND the attachments. We descend the whole tree.
 */
function walkPayload(msg: GmailMessageDetail): {
  body: string;
  attachments: GmailAttachment[];
} {
  let plain = '';
  let html = '';
  const attachments: GmailAttachment[] = [];

  const visit = (part: GmailPart) => {
    const mime = (part.mimeType || '').toLowerCase();

    // An attachment: has a filename, or carries an attachmentId for fetching.
    if (part.filename || part.body?.attachmentId) {
      if (part.body?.attachmentId) {
        attachments.push({
          filename: part.filename || '(unnamed)',
          mime_type: part.mimeType || 'application/octet-stream',
          size: part.body.size ?? 0,
          attachment_id: part.body.attachmentId,
        });
      }
      // Don't treat an attachment's bytes as the message body.
    } else if (mime === 'text/plain' && part.body?.data) {
      plain += decodeBase64Url(part.body.data);
    } else if (mime === 'text/html' && part.body?.data) {
      html += decodeBase64Url(part.body.data);
    }

    for (const child of part.parts ?? []) visit(child);
  };

  visit(msg.payload);

  const body = plain.trim() || (html ? stripHtml(html) : '') || msg.snippet;
  return { body, attachments };
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
