import type { Env } from '../index';
import { googleFetch, type GoogleAccount } from './google-auth';

// Google Docs editing. Requires the 'documents' scope (already in the
// FULL_SCOPES set in scripts/bootstrap-google-oauth.mjs).

interface DocAppendInput {
  doc_id: string;
  text: string;
  account?: GoogleAccount;
}

// Appends text to the end of a Doc's body. Adds a leading newline so the
// new content starts on its own line — call sites don't need to bake it in.
export async function docAppend(env: Env, input: DocAppendInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const endIndex = await getBodyEndIndex(env, input.doc_id, account);

  const payload = {
    requests: [
      {
        insertText: {
          location: { index: endIndex - 1 },
          text: input.text.startsWith('\n') ? input.text : `\n${input.text}`,
        },
      },
    ],
  };

  const res = await googleFetch(
    env,
    `https://docs.googleapis.com/v1/documents/${input.doc_id}:batchUpdate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    account,
  );
  if (!res.ok) throw new Error(`Doc append (${account}) failed: ${res.status} ${await res.text()}`);
  return { ok: true, account, doc_id: input.doc_id, appended_chars: input.text.length };
}

interface DocReplaceBodyInput {
  doc_id: string;
  body: string;
  account?: GoogleAccount;
}

// Replaces the entire body of a Doc with `body`. Destructive — the old
// content is gone. Use doc_find_replace for targeted edits.
export async function docReplaceBody(env: Env, input: DocReplaceBodyInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const endIndex = await getBodyEndIndex(env, input.doc_id, account);

  const requests: unknown[] = [];
  // Body always starts at index 1; endIndex is one past the trailing newline,
  // which we must NOT delete (the Docs API rejects deleting the final newline).
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  if (input.body.length > 0) {
    requests.push({ insertText: { location: { index: 1 }, text: input.body } });
  }

  if (requests.length === 0) {
    return { ok: true, account, doc_id: input.doc_id, replaced_chars: 0, note: 'doc already empty' };
  }

  const res = await googleFetch(
    env,
    `https://docs.googleapis.com/v1/documents/${input.doc_id}:batchUpdate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests }) },
    account,
  );
  if (!res.ok) throw new Error(`Doc replace body (${account}) failed: ${res.status} ${await res.text()}`);
  return { ok: true, account, doc_id: input.doc_id, replaced_chars: input.body.length };
}

interface DocFindReplaceInput {
  doc_id: string;
  edits: Array<{ find: string; replace: string; match_case?: boolean }>;
  account?: GoogleAccount;
}

// Find/replace across the whole doc. Each edit runs as a separate
// replaceAllText request; the response tells you how many occurrences each
// one hit.
export async function docFindReplace(env: Env, input: DocFindReplaceInput): Promise<unknown> {
  const account = input.account ?? 'work';
  if (!input.edits?.length) throw new Error('doc_find_replace: edits array is empty');

  const requests = input.edits.map((e) => ({
    replaceAllText: {
      containsText: { text: e.find, matchCase: e.match_case ?? true },
      replaceText: e.replace,
    },
  }));

  const res = await googleFetch(
    env,
    `https://docs.googleapis.com/v1/documents/${input.doc_id}:batchUpdate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests }) },
    account,
  );
  if (!res.ok) throw new Error(`Doc find/replace (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> };
  const replacements = (data.replies ?? []).map((r, i) => ({
    find: input.edits[i].find,
    occurrences: r.replaceAllText?.occurrencesChanged ?? 0,
  }));
  return { ok: true, account, doc_id: input.doc_id, replacements };
}

// Fetches the body end index for placement of insertions/deletions.
// The body's last structural element has an endIndex one past the trailing
// newline; we treat that as the "end" pointer.
async function getBodyEndIndex(env: Env, docId: string, account: GoogleAccount): Promise<number> {
  const res = await googleFetch(env, `https://docs.googleapis.com/v1/documents/${docId}?fields=body.content.endIndex`, {}, account);
  if (!res.ok) throw new Error(`Doc get (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { body?: { content?: Array<{ endIndex?: number }> } };
  const elements = data.body?.content ?? [];
  const last = elements[elements.length - 1];
  if (!last?.endIndex) throw new Error(`Doc ${docId}: could not determine end index`);
  return last.endIndex;
}
