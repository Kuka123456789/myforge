// Telegram Bot API client. Docs: https://core.telegram.org/bots/api

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: { file_id: string; mime_type?: string; duration: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

const API_BASE = 'https://api.telegram.org';

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? 'unknown'}`);
  }
  return data.result as T;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: { replyTo?: number; parseMode?: 'MarkdownV2' | 'Markdown' | 'HTML' } = {},
): Promise<void> {
  // Telegram caps messages at 4096 chars. Chunk longer replies.
  const chunks = chunkText(text, 4000);
  for (const chunk of chunks) {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: opts.replyTo,
      // Don't error if the original message has aged out of Telegram's reply window.
      allow_sending_without_reply: true,
      parse_mode: opts.parseMode,
      disable_web_page_preview: true,
    });
  }
}

export async function sendChatAction(
  token: string,
  chatId: number,
  action: 'typing' | 'upload_document' | 'upload_photo',
): Promise<void> {
  await call(token, 'sendChatAction', { chat_id: chatId, action });
}

export async function fetchTelegramFile(
  token: string,
  fileId: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string; fileName: string }> {
  const meta = await call<TelegramFile>(token, 'getFile', { file_id: fileId });
  if (!meta.file_path) throw new Error('Telegram getFile returned no file_path');
  const fileRes = await fetch(`${API_BASE}/file/bot${token}/${meta.file_path}`);
  if (!fileRes.ok) throw new Error(`Failed to fetch Telegram file: ${fileRes.status}`);
  const bytes = await fileRes.arrayBuffer();
  // Best-effort mime type guess from extension.
  const ext = meta.file_path.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = guessMime(ext, fileRes.headers.get('content-type'));
  const fileName = meta.file_path.split('/').pop() ?? 'file';
  return { bytes, mimeType, fileName };
}

function guessMime(ext: string, headerType: string | null): string {
  if (headerType && headerType !== 'application/octet-stream') return headerType;
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
  };
  return map[ext] ?? 'application/octet-stream';
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer breaking on a newline near the limit; otherwise hard split.
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
