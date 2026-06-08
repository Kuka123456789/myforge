import type { Env } from '../index';
import { fetchTelegramFile } from '../telegram';
import { getGoogleAccessToken, googleFetch, type GoogleAccount } from './google-auth';

// Drive list/search/fetch + folder/doc creation. Requires the full
// https://www.googleapis.com/auth/drive scope (NOT drive.file).
// Re-run scripts/bootstrap-google-oauth.mjs if you only have drive.file.

interface DriveListInput {
  folder_id?: string; // omit + no query → lists root
  query?: string; // free-text name match; combined with folder constraint
  max_results?: number;
  account?: GoogleAccount;
}

export async function driveList(env: Env, input: DriveListInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const max = Math.min(input.max_results ?? 25, 100);

  const qParts: string[] = ['trashed = false'];
  if (input.folder_id) qParts.push(`'${input.folder_id.replace(/'/g, "\\'")}' in parents`);
  if (input.query) qParts.push(`name contains '${input.query.replace(/'/g, "\\'")}'`);

  // Always include Shared Drive content. Without these flags the API silently
  // returns 0 results for folders that live on a Shared Drive — looks like
  // "empty folder" but is actually a missing capability flag.
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', qParts.join(' and '));
  url.searchParams.set('pageSize', String(max));
  url.searchParams.set('fields', 'files(id,name,mimeType,parents,modifiedTime,webViewLink,owners(emailAddress)),nextPageToken');
  url.searchParams.set('orderBy', 'folder,modifiedTime desc');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const res = await googleFetch(env, url.toString(), {}, account);
  if (!res.ok) throw new Error(`Drive list (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink: string }>;
    nextPageToken?: string;
  };
  return {
    account,
    folder_id: input.folder_id ?? 'root',
    count: data.files?.length ?? 0,
    files: (data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      kind: kindFromMime(f.mimeType),
      mime: f.mimeType,
      modified: f.modifiedTime,
      link: f.webViewLink,
    })),
    has_more: Boolean(data.nextPageToken),
  };
}

interface DriveCreateFolderInput {
  name: string;
  parent_id?: string;
  account?: GoogleAccount;
}

export async function driveCreateFolder(env: Env, input: DriveCreateFolderInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const body = {
    name: input.name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: input.parent_id ? [input.parent_id] : undefined,
  };
  const res = await googleFetch(
    env,
    'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    account,
  );
  if (!res.ok) throw new Error(`Drive create folder (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: string; name: string; webViewLink: string };
  return { ok: true, account, folder_id: data.id, name: data.name, link: data.webViewLink };
}

interface DriveGetFileInput {
  file_id: string;
  include_content?: boolean; // text export for Docs/Sheets/Slides
  account?: GoogleAccount;
}

export async function driveGetFile(env: Env, input: DriveGetFileInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${input.file_id}?fields=id,name,mimeType,parents,modifiedTime,size,webViewLink,owners(emailAddress)&supportsAllDrives=true`;
  const metaRes = await googleFetch(env, metaUrl, {}, account);
  if (!metaRes.ok) throw new Error(`Drive get file (${account}) failed: ${metaRes.status} ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size?: string;
    webViewLink: string;
  };

  let content: string | undefined;
  let content_truncated = false;
  if (input.include_content) {
    const exportMime = exportMimeFor(meta.mimeType);
    if (exportMime) {
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${input.file_id}/export?mimeType=${encodeURIComponent(exportMime)}`;
      const exportRes = await googleFetch(env, exportUrl, {}, account);
      if (exportRes.ok) {
        const text = await exportRes.text();
        content = text.slice(0, 12000);
        content_truncated = text.length > 12000;
      }
    } else if (meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json') {
      const dlRes = await googleFetch(env, `https://www.googleapis.com/drive/v3/files/${input.file_id}?alt=media&supportsAllDrives=true`, {}, account);
      if (dlRes.ok) {
        const text = await dlRes.text();
        content = text.slice(0, 12000);
        content_truncated = text.length > 12000;
      }
    }
  }

  return {
    account,
    id: meta.id,
    name: meta.name,
    kind: kindFromMime(meta.mimeType),
    mime: meta.mimeType,
    modified: meta.modifiedTime,
    size_bytes: meta.size ? Number(meta.size) : null,
    link: meta.webViewLink,
    content,
    content_truncated,
  };
}

interface DocCreateInput {
  title: string;
  body?: string; // markdown/plain-text; Drive converts to a Doc
  parent_folder_id?: string;
  account?: GoogleAccount;
}

export async function docCreate(env: Env, input: DocCreateInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const token = await getGoogleAccessToken(env, account);

  const metadata = {
    name: input.title,
    mimeType: 'application/vnd.google-apps.document',
    parents: input.parent_folder_id ? [input.parent_folder_id] : undefined,
  };

  const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const body = input.body ?? '';
  const header =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;
  const headerBytes = enc.encode(header);
  const bodyBytes = enc.encode(body);
  const footerBytes = enc.encode(footer);
  const out = new Uint8Array(headerBytes.length + bodyBytes.length + footerBytes.length);
  out.set(headerBytes, 0);
  out.set(bodyBytes, headerBytes.length);
  out.set(footerBytes, headerBytes.length + bodyBytes.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body: out,
    },
  );
  if (!res.ok) throw new Error(`Doc create (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: string; name: string; webViewLink: string };
  return { ok: true, account, doc_id: data.id, title: data.name, link: data.webViewLink };
}

function kindFromMime(mime: string): string {
  if (mime === 'application/vnd.google-apps.folder') return 'folder';
  if (mime === 'application/vnd.google-apps.document') return 'doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  if (mime === 'application/vnd.google-apps.presentation') return 'slides';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
}

function exportMimeFor(mime: string): string | null {
  if (mime === 'application/vnd.google-apps.document') return 'text/plain';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'text/csv';
  if (mime === 'application/vnd.google-apps.presentation') return 'text/plain';
  return null;
}

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
