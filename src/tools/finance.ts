import type { Env } from '../index';
import { googleFetch } from './google-auth';

// Personal Finance Ledger (Daniel's personal Google account). The ledger lives on
// the PERSONAL Google account, so every call here uses account: 'personal'.
// Override the sheet via env.FINANCE_SHEET_ID; otherwise this default is used.
const DEFAULT_FINANCE_SHEET_ID = '1ScOrdEWD2usXwLhC329agyHMEH2nTi7S-JUXkZo_vSM';
const LEDGER_TAB = 'Ledger';
const RULES_TAB = 'Rules';

// Ledger columns A..M (must match the Sheet exactly):
//   A date | B account | C merchant | D amount_native | E currency | F fx_rate |
//   G amount_ils | H flow_type | I category | J is_reimbursable | K is_refundable |
//   L source_file | M notes
type FlowType = 'spend' | 'income' | 'transfer' | 'capital' | 'excluded';

function sheetId(env: Env): string {
  return env.FINANCE_SHEET_ID || DEFAULT_FINANCE_SHEET_ID;
}

// Every finance tool returns this, so the model can reach the ledger with the generic
// sheets_read/sheets_write (account: 'personal') for anything the typed tools don't cover.
function ledgerRef(env: Env) {
  return {
    sheet_id: sheetId(env),
    tab: LEDGER_TAB,
    account: 'personal' as const,
    sheet_link: `https://docs.google.com/spreadsheets/d/${sheetId(env)}/edit`,
  };
}

// Today's date (YYYY-MM-DD) in the operator's timezone so a late-night log doesn't
// land on the wrong calendar day.
function todayInTz(tz: string | undefined): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA -> YYYY-MM-DD
}

// Read the Rules tab and apply the same matching the Python importer uses:
// case-insensitive substring of `pattern` in `merchant`, longest pattern wins.
async function categorise(
  env: Env,
  merchant: string,
): Promise<{ category: string; flow_type: FlowType } | null> {
  const range = `${RULES_TAB}!A2:C`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId(env)}/values/${encodeURIComponent(range)}`;
  const res = await googleFetch(env, url, {}, 'personal');
  if (!res.ok) return null; // categorisation is best-effort; fall back to UNCATEGORIZED
  const data = (await res.json()) as { values?: string[][] };
  const m = merchant.toLowerCase();
  let best: { pattern: string; category: string; flow: string } | null = null;
  for (const row of data.values ?? []) {
    const [pattern, category, flow] = row;
    if (pattern && category && m.includes(pattern.toLowerCase())) {
      if (!best || pattern.length > best.pattern.length) best = { pattern, category, flow };
    }
  }
  if (!best) return null;
  return { category: best.category, flow_type: (best.flow as FlowType) || 'spend' };
}

// One ledger row, plus the 1-indexed sheet row it lives on (row 1 = header).
interface LedgerRow {
  row: number;
  date: string;
  account: string;
  merchant: string;
  amount: number;
  currency: string;
  fx_rate: number;
  amount_ils: number;
  flow_type: string;
  category: string;
  is_reimbursable: boolean;
  is_refundable: boolean;
  source_file: string;
  notes: string;
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? '').replace(/[,\s₪]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function bool(v: string | undefined): boolean {
  return /^(true|yes|1)$/i.test(String(v ?? '').trim());
}

function toLedgerRow(values: string[], row: number): LedgerRow {
  const c = (i: number) => values[i] ?? '';
  return {
    row,
    date: c(0),
    account: c(1),
    merchant: c(2),
    amount: num(c(3)),
    currency: c(4),
    fx_rate: num(c(5)) || 1,
    amount_ils: num(c(6)),
    flow_type: c(7),
    category: c(8),
    is_reimbursable: bool(c(9)),
    is_refundable: bool(c(10)),
    source_file: c(11),
    notes: c(12),
  };
}

async function readLedger(env: Env, range: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId(env)}/values/${encodeURIComponent(range)}`;
  const res = await googleFetch(env, url, {}, 'personal');
  if (!res.ok) throw new Error(`finance ledger read failed (personal): ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { values?: string[][] };
  return data.values ?? [];
}

export interface FinanceFindInput {
  merchant?: string; // case-insensitive substring
  account?: string; // case-insensitive substring
  category?: string; // exact, case-insensitive
  flow_type?: FlowType;
  date_from?: string; // YYYY-MM-DD, inclusive
  date_to?: string; // YYYY-MM-DD, inclusive
  amount_min?: number; // on the signed native amount
  amount_max?: number;
  limit?: number; // default 20, most recent rows first
}

// Find ledger rows so they can be edited. Returns each match with its sheet row
// number, which is what finance_update takes.
export async function financeFind(env: Env, input: FinanceFindInput): Promise<unknown> {
  const values = await readLedger(env, `${LEDGER_TAB}!A2:M`);
  const rows = values.map((v, i) => toLedgerRow(v, i + 2)).filter((r) => r.date || r.merchant);

  const m = input.merchant?.toLowerCase();
  const acct = input.account?.toLowerCase();
  const cat = input.category?.toLowerCase();

  const matches = rows.filter((r) => {
    if (m && !r.merchant.toLowerCase().includes(m)) return false;
    if (acct && !r.account.toLowerCase().includes(acct)) return false;
    if (cat && r.category.toLowerCase() !== cat) return false;
    if (input.flow_type && r.flow_type !== input.flow_type) return false;
    if (input.date_from && r.date < input.date_from) return false;
    if (input.date_to && r.date > input.date_to) return false;
    if (input.amount_min !== undefined && r.amount < input.amount_min) return false;
    if (input.amount_max !== undefined && r.amount > input.amount_max) return false;
    return true;
  });

  const limit = input.limit && input.limit > 0 ? input.limit : 20;
  // Newest rows sit at the bottom of the ledger; show those first.
  const page = matches.slice(-limit).reverse();
  return {
    ok: true,
    matched: matches.length,
    returned: page.length,
    rows: page,
    ...ledgerRef(env),
  };
}

export interface FinanceUpdateInput {
  row: number; // 1-indexed sheet row from finance_find
  merchant?: string;
  amount?: number; // signed, native currency
  account?: string;
  date?: string;
  currency?: string;
  amount_ils?: number;
  category?: string;
  flow_type?: FlowType;
  is_reimbursable?: boolean;
  is_refundable?: boolean;
  notes?: string;
}

// Patch an existing ledger row in place. Only the fields passed change; fx_rate and
// amount_ils are re-derived whenever amount/currency move.
export async function financeUpdate(env: Env, input: FinanceUpdateInput): Promise<unknown> {
  const row = Number(input.row);
  if (!Number.isInteger(row) || row < 2) {
    throw new Error('row must be an integer >= 2 (row 1 is the header). Use finance_find to get it.');
  }

  const range = `${LEDGER_TAB}!A${row}:M${row}`;
  const existingValues = await readLedger(env, range);
  if (!existingValues.length || !existingValues[0]?.some((v) => String(v ?? '').trim())) {
    throw new Error(`Ledger row ${row} is empty — nothing to update. Re-run finance_find; row numbers shift only if rows were deleted.`);
  }
  const before = toLedgerRow(existingValues[0], row);

  const date = input.date ?? before.date;
  const account = input.account ?? before.account;
  const merchant = input.merchant ?? before.merchant;
  const amount = input.amount ?? before.amount;
  const currency = (input.currency ?? before.currency ?? 'ILS').toUpperCase();

  // amount_ils: explicit wins; for ILS it tracks the native amount; otherwise hold the
  // row's existing FX rate so changing only the amount still lands on a sane shekel value.
  let amountIls: number;
  if (input.amount_ils !== undefined) amountIls = input.amount_ils;
  else if (currency === 'ILS') amountIls = amount;
  else if (currency === before.currency && before.fx_rate) amountIls = amount * before.fx_rate;
  else if (amount === before.amount && currency === before.currency) amountIls = before.amount_ils;
  else throw new Error(`amount_ils is required when switching to ${currency} (the Worker has no FX source).`);
  if (amount < 0 !== amountIls < 0) amountIls = -amountIls; // align signs
  const fxRate =
    currency === 'ILS' || amount === 0
      ? 1
      : Math.round((Math.abs(amountIls) / Math.abs(amount)) * 1e4) / 1e4;

  // A renamed merchant usually means the old category is wrong, so re-run the Rules
  // match unless the caller pinned a category explicitly.
  let category = input.category ?? before.category;
  let flow: FlowType = input.flow_type ?? (before.flow_type as FlowType) ?? 'spend';
  if (!input.category && input.merchant && input.merchant !== before.merchant) {
    const matched = await categorise(env, merchant);
    if (matched) {
      category = matched.category;
      if (!input.flow_type) flow = matched.flow_type;
    }
  }

  const after: LedgerRow = {
    row,
    date,
    account,
    merchant,
    amount,
    currency,
    fx_rate: fxRate,
    amount_ils: amountIls,
    flow_type: flow,
    category,
    is_reimbursable: input.is_reimbursable ?? before.is_reimbursable,
    is_refundable: input.is_refundable ?? before.is_refundable,
    source_file: before.source_file, // provenance stays with the original import
    notes: input.notes ?? before.notes,
  };

  const values = [
    [
      after.date,
      after.account,
      after.merchant,
      after.amount.toFixed(2),
      after.currency,
      after.fx_rate,
      after.amount_ils.toFixed(2),
      after.flow_type,
      after.category,
      after.is_reimbursable ? 'TRUE' : 'FALSE',
      after.is_refundable ? 'TRUE' : 'FALSE',
      after.source_file,
      after.notes,
    ],
  ];

  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId(env)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  const res = await googleFetch(
    env,
    url.toString(),
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) },
    'personal',
  );
  if (!res.ok) {
    throw new Error(`finance_update failed (personal): ${res.status} ${await res.text()}`);
  }

  const changed = (Object.keys(after) as (keyof LedgerRow)[]).filter(
    (k) => k !== 'row' && after[k] !== before[k],
  );
  return {
    ok: true,
    row,
    changed,
    before,
    after,
    ...ledgerRef(env),
  };
}

export interface FinanceLogInput {
  merchant: string;
  // Signed: NEGATIVE = money out (spend), POSITIVE = money in (income).
  amount: number;
  account?: string; // e.g. "Cash", "Hapoalim Checking". Default "Cash".
  date?: string; // YYYY-MM-DD. Default = today (operator tz).
  currency?: string; // Default "ILS".
  amount_ils?: number; // Signed ILS. Required if currency != ILS.
  category?: string; // If omitted, auto from the Rules tab.
  flow_type?: FlowType; // If omitted, from the matched rule, else "spend".
  is_reimbursable?: boolean; // Default false.
  notes?: string;
}

export async function financeLog(env: Env, input: FinanceLogInput): Promise<unknown> {
  if (!input.merchant) throw new Error('merchant is required');
  if (typeof input.amount !== 'number' || Number.isNaN(input.amount)) {
    throw new Error('amount (signed number; negative = spend) is required');
  }

  const currency = (input.currency || 'ILS').toUpperCase();
  const date = input.date || todayInTz(env.OPERATOR_TIMEZONE);
  const account = input.account || 'Cash';

  // amount_ils: for ILS it equals the native amount; otherwise it must be supplied
  // (the Worker has no FX source). Keep the sign consistent with the native amount.
  let amountIls = input.amount_ils;
  if (amountIls === undefined) {
    if (currency === 'ILS') amountIls = input.amount;
    else
      throw new Error(
        `amount_ils is required for non-ILS (${currency}). Pass the ILS value of the charge.`,
      );
  }
  if (input.amount < 0 !== amountIls < 0) amountIls = -amountIls; // align signs
  const fxRate = currency === 'ILS' ? 1 : Math.round((Math.abs(amountIls) / Math.abs(input.amount)) * 1e4) / 1e4;

  // Category / flow: explicit wins, else auto from Rules, else UNCATEGORIZED/spend.
  let category = input.category;
  let flow: FlowType = input.flow_type ?? 'spend';
  if (!category) {
    const matched = await categorise(env, input.merchant);
    if (matched) {
      category = matched.category;
      if (!input.flow_type) flow = matched.flow_type;
    } else {
      category = 'UNCATEGORIZED';
    }
  }

  const row = [
    date,
    account,
    input.merchant,
    input.amount.toFixed(2),
    currency,
    fxRate,
    amountIls.toFixed(2),
    flow,
    category,
    input.is_reimbursable ? 'TRUE' : 'FALSE',
    'FALSE', // is_refundable — flag manually later if it's a standalone deposit
    'telegram',
    input.notes ?? '',
  ];

  const range = `${LEDGER_TAB}!A:M`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId(env)}/values/${encodeURIComponent(range)}:append`,
  );
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');

  const res = await googleFetch(
    env,
    url.toString(),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: [row] }) },
    'personal',
  );
  if (!res.ok) {
    throw new Error(`finance_log append failed (personal): ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { updates?: { updatedRange?: string } };
  return {
    ok: true,
    logged: { date, account, merchant: input.merchant, amount: input.amount, currency, amount_ils: amountIls, flow_type: flow, category },
    updated_range: data.updates?.updatedRange ?? null,
    ...ledgerRef(env),
  };
}
