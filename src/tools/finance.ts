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
    sheet_link: `https://docs.google.com/spreadsheets/d/${sheetId(env)}/edit`,
  };
}
