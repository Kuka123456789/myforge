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
