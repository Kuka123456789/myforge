import type { Env } from '../index';
import { fetchTelegramFile } from '../telegram';
import { getGoogleAccessToken, type GoogleAccount } from './google-auth';

interface UploadInvoiceInput {
  file_id: string;
  file_name?: string;
  mime?: string;
  vendor?: string;
  date?: string;
  category?: 'IT' | 'Travel';
  // Cross-account routing. Defaults to work + the configured invoices folder.
  account?: GoogleAccount;
  folder_id?: string;
}

export async function driveUploadInvoice(env: Env, input: UploadInvoiceInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const file = await fetchTelegramFile(env.TELEGRAM_BOT_TOKEN, input.file_id);
  const mime = input.mime ?? file.mimeType;

  const baseName = makeInvoiceName(input, file.fileName);
  const folderId = input.folder_id ?? (account === 'work' ? env.INVOICES_DRIVE_FOLDER_ID : undefined);
  if (!folderId) {
    throw new Error(`folder_id required when uploading to ${account} account (no default configured).`);
  }

  const token = await getGoogleAccessToken(env, account);

  // Multipart upload to Drive v3.
  const metadata = {
    name: baseName,
    mimeType: mime,
    parents: folderId ? [folderId] : undefined,
  };

  const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;
  const body = buildMultipartBody(boundary, metadata, file.bytes, mime);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  if (!res.ok) {
    throw new Error(`Drive upload (${account}) failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { id: string; name: string; webViewLink: string };
  return {
    ok: true,
    account,
    file_id: data.id,
    name: data.name,
    link: data.webViewLink,
  };
}

function makeInvoiceName(input: UploadInvoiceInput, fallback: string): string {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const vendor = (input.vendor ?? 'invoice').replace(/[^\w\s-]/g, '').trim().slice(0, 60);
  const category = input.category ?? 'IT';
  const ext = fallback.includes('.') ? fallback.split('.').pop() : 'pdf';
  return `${date} ${category} ${vendor}.${ext}`;
}

function buildMultipartBody(
  boundary: string,
  metadata: object,
  bytes: ArrayBuffer,
  mime: string,
): Uint8Array {
  const enc = new TextEncoder();
  const header =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n` +
    `Content-Transfer-Encoding: binary\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const headerBytes = enc.encode(header);
  const footerBytes = enc.encode(footer);
  const fileBytes = new Uint8Array(bytes);

  const out = new Uint8Array(headerBytes.length + fileBytes.length + footerBytes.length);
  out.set(headerBytes, 0);
  out.set(fileBytes, headerBytes.length);
  out.set(footerBytes, headerBytes.length + fileBytes.length);
  return out;
}
