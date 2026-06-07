import type { Env } from '../index';
import { googleFetch, type GoogleAccount } from './google-auth';

// MyForge Log tab columns (1-indexed): A Date | B Vendor | C Category | D Type | E Amount
// F Currency | G Paid By | H Drive link | I Notes | J Logged at

interface AppendInput {
  bucket: 'IT' | 'Travel';
  date: string;
  vendor: string;
  category: string;
  type: 'One-Time' | 'Monthly' | 'Yearly';
  amount: number;
  currency: string;
  paid_by: string;
  drive_link?: string;
  notes?: string;
}

export async function sheetsAppendExpense(env: Env, input: AppendInput): Promise<unknown> {
  const tab = input.bucket === 'Travel' ? env.EXPENSES_TRAVEL_TAB : env.EXPENSES_IT_TAB;
  const range = `${tab}!A:J`;

  const row = [
    input.date,
    input.vendor,
    input.category,
    input.type,
    input.amount,
    input.currency,
    input.paid_by,
    input.drive_link ?? '',
    input.notes ?? '',
    new Date().toISOString(),
  ];

  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.EXPENSES_SHEET_ID}/values/${encodeURIComponent(range)}:append`,
  );
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');

  const res = await googleFetch(env, url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { updates?: { updatedRange?: string } };
  return {
    ok: true,
    bucket: input.bucket,
    tab,
    updated_range: data.updates?.updatedRange ?? null,
    sheet_link: `https://docs.google.com/spreadsheets/d/${env.EXPENSES_SHEET_ID}/edit`,
  };
}

interface ReadInput {
  tab: string;
  range?: string;
  sheet_id?: string; // override; defaults to expenses sheet (work)
  account?: GoogleAccount;
}

export async function sheetsRead(env: Env, input: ReadInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const sheetId = input.sheet_id ?? env.EXPENSES_SHEET_ID;
  if (!sheetId) throw new Error('sheet_id required when reading a non-default sheet');

  const range = input.range ? `${input.tab}!${input.range}` : `${input.tab}!A1:Z200`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await googleFetch(env, url, {}, account);
  if (!res.ok) throw new Error(`Sheets read (${account}) failed: ${res.status} ${await res.text()}`);
  return res.json();
}

interface CreateInput {
  title: string;
  tabs?: string[]; // tab names (defaults to ['Sheet1'])
  parent_folder_id?: string;
  account?: GoogleAccount;
}

export async function sheetsCreate(env: Env, input: CreateInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const tabs = input.tabs && input.tabs.length > 0 ? input.tabs : ['Sheet1'];

  const body = {
    properties: { title: input.title },
    sheets: tabs.map((name) => ({ properties: { title: name } })),
  };
  const res = await googleFetch(
    env,
    'https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties.title',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    account,
  );
  if (!res.ok) throw new Error(`Sheets create (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties: { title: string };
    sheets: Array<{ properties: { title: string } }>;
  };

  // If a parent folder was specified, move the new file there via Drive.
  if (input.parent_folder_id) {
    const moveRes = await googleFetch(
      env,
      `https://www.googleapis.com/drive/v3/files/${data.spreadsheetId}?addParents=${input.parent_folder_id}&removeParents=root&supportsAllDrives=true&fields=id,parents`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' },
      account,
    );
    if (!moveRes.ok) {
      console.log(`[sheets_create] warn: created but couldn't move to folder: ${moveRes.status}`);
    }
  }

  return {
    ok: true,
    account,
    sheet_id: data.spreadsheetId,
    title: data.properties.title,
    tabs: data.sheets.map((s) => s.properties.title),
    link: data.spreadsheetUrl,
  };
}

interface WriteInput {
  sheet_id: string;
  tab: string;
  range?: string; // A1 notation within the tab; default A1
  values: (string | number | boolean | null)[][]; // 2D row-major
  account?: GoogleAccount;
}

export async function sheetsWrite(env: Env, input: WriteInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const range = input.range ? `${input.tab}!${input.range}` : `${input.tab}!A1`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${input.sheet_id}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set('valueInputOption', 'USER_ENTERED');

  const res = await googleFetch(
    env,
    url.toString(),
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: input.values }) },
    account,
  );
  if (!res.ok) throw new Error(`Sheets write (${account}) failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { updatedRange?: string; updatedCells?: number };
  return {
    ok: true,
    account,
    sheet_id: input.sheet_id,
    updated_range: data.updatedRange,
    updated_cells: data.updatedCells,
    link: `https://docs.google.com/spreadsheets/d/${input.sheet_id}/edit`,
  };
}

interface AddTabInput {
  sheet_id: string;
  title: string;
  account?: GoogleAccount;
}

export async function sheetsAddTab(env: Env, input: AddTabInput): Promise<unknown> {
  const account = input.account ?? 'work';
  const body = { requests: [{ addSheet: { properties: { title: input.title } } }] };
  const res = await googleFetch(
    env,
    `https://sheets.googleapis.com/v4/spreadsheets/${input.sheet_id}:batchUpdate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    account,
  );
  if (!res.ok) throw new Error(`Sheets add tab (${account}) failed: ${res.status} ${await res.text()}`);
  return {
    ok: true,
    account,
    sheet_id: input.sheet_id,
    tab: input.title,
    link: `https://docs.google.com/spreadsheets/d/${input.sheet_id}/edit`,
  };
}
