import type { Env } from '../index';
import type { MemoryType } from '../memory';
import type { ToolDefinition } from '../types';
import { calendarCreateEvent, calendarDeleteEvent, calendarListCalendars, calendarListEvents } from './calendar';
import { docAppend, docFindReplace, docReplaceBody } from './docs';
import {
  docCreate,
  driveCreateFolder,
  driveGetFile,
  driveList,
  driveMove,
  driveRename,
  driveTrash,
  driveUpdateContent,
  driveUploadInvoice,
} from './drive';
import { githubCodeSearch, githubFileGet, githubIssueSearch, githubRepoStats } from './github';
import { gmailGetAttachment, gmailRead, gmailSearch, gmailSearchBoth } from './gmail';
import { memoryBulkSave, memoryDelete, memorySave, memoryView } from './memory';
import { reminderCancel, reminderList, reminderSet } from './reminders';
import { readTranscriptRange, searchTranscripts } from '../transcripts';
import { sheetsAddTab, sheetsAppendExpense, sheetsCreate, sheetsInfo, sheetsRead, sheetsWrite } from './sheets';
import { financeLog } from './finance';

export interface ToolContext {
  env: Env;
  chat_id: number;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'gmail_search',
    description:
      "Search Gmail. account: 'work' (default) or 'personal'. Gmail query syntax e.g. 'from:someone is:unread newer_than:7d'. For body, call gmail_read with the same account.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
        max_results: { type: 'integer', description: 'Max messages to return (1-20)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_search_both',
    description:
      "Search BOTH work and personal Gmail in parallel with the SAME query. Use this as the DEFAULT when the operator asks about email without specifying an account; never default-fail to only work. Returns separate result lists for each account.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail query (same syntax)' },
        max_results: { type: 'integer', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description:
      "Full body of a Gmail message by id. Pass the same account you searched in. Returns up to 20k chars of body plus an `attachments` list ({filename, mime_type, size, attachment_id}). If body_truncated is true, call again with offset=next_offset to read the rest. Use gmail_get_attachment to read a listed attachment.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
        offset: { type: 'integer', description: 'Char offset into the body to start from (for paging long messages); defaults to 0', default: 0 },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_get_attachment',
    description:
      "Read a Gmail attachment's content. Get message_id + attachment_id from gmail_read's `attachments` list. Text-based attachments (text/*, csv, json, xml, ics) are returned inline; binary types (PDF, images, office docs) return metadata only — for those, offer the Gmail link or to save to Drive.",
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        attachment_id: { type: 'string', description: 'From gmail_read attachments[].attachment_id' },
        filename: { type: 'string', description: 'From gmail_read attachments[].filename (helps type detection)' },
        mime_type: { type: 'string', description: 'From gmail_read attachments[].mime_type' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['message_id', 'attachment_id'],
    },
  },
  {
    name: 'sheets_append_expense',
    description:
      "Append expense row. bucket: IT (software/hw/services/domains) | Travel (flights/cabs/hotels/meals). category: free-text within-bucket tag. type: One-Time|Monthly|Yearly. Always pass drive_link if you just uploaded the invoice.",
    input_schema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', enum: ['IT', 'Travel'] },
        date: { type: 'string', description: 'YYYY-MM-DD of the invoice/receipt' },
        vendor: { type: 'string', description: "e.g. 'Apple', 'Iberia', 'Anthropic'" },
        category: { type: 'string', description: "e.g. Software, Hardware, Domain, Service, Flights, Cabs, Hotels, Meals" },
        type: { type: 'string', enum: ['One-Time', 'Monthly', 'Yearly'] },
        amount: { type: 'number' },
        currency: { type: 'string', description: "ISO code: GBP, USD, EUR, etc." },
        paid_by: { type: 'string', description: 'Who paid (free-text; see operator context for the canonical values used in your sheet)' },
        drive_link: { type: 'string', description: 'webViewLink from drive_upload_invoice' },
        notes: { type: 'string' },
      },
      required: ['bucket', 'date', 'vendor', 'category', 'type', 'amount', 'currency', 'paid_by'],
    },
  },
  {
    name: 'finance_log',
    description:
      "Log ONE transaction to Daniel's PERSONAL Finance Ledger (a separate Google Sheet from the work expense sheet). Use this when Daniel says things like 'log 45 shekels coffee, cash' or 'I paid 200 cash to the trainer'. " +
      'amount is SIGNED: negative = money out (spend), positive = money in (income) — a 45-shekel coffee is amount: -45. ' +
      'Category and flow_type are auto-derived from the ledger Rules tab if you omit them; only pass category to override. ' +
      'Default account is "Cash". IMPORTANT: use this for CASH and other manual items the bank statements cannot see (cash rent, the trainer, vaad bayit). Do NOT log card/bank charges here — those come in via the /finance-import statement flow, and logging them twice double-counts. ' +
      'For non-ILS amounts you must also pass amount_ils (the shekel value). To READ/summarise the ledger, use sheets_read with account: "personal" against this sheet instead.',
    input_schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: "Payee/description, e.g. 'Cofix', 'Alik (trainer)'" },
        amount: { type: 'number', description: 'SIGNED amount in the native currency. Negative = spend, positive = income.' },
        account: { type: 'string', description: 'Account name. Default "Cash". Others: "Hapoalim Checking", "Revolut Pro", etc.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today (operator timezone).' },
        currency: { type: 'string', description: 'ISO code, default "ILS".' },
        amount_ils: { type: 'number', description: 'Signed ILS value. Required only when currency is not ILS.' },
        category: { type: 'string', description: 'Override the auto-categorisation. Must be an existing category in the Categories tab.' },
        flow_type: { type: 'string', enum: ['spend', 'income', 'transfer', 'capital', 'excluded'], description: 'Defaults from the matched rule, else "spend".' },
        is_reimbursable: { type: 'boolean', description: 'TRUE if Greenbay reimburses it (AI/dev tools, hardware). Default false.' },
        notes: { type: 'string' },
      },
      required: ['merchant', 'amount'],
    },
  },
  {
    name: 'sheets_info',
    description:
      "List a spreadsheet's tab (sheet) names plus its title, before reading or writing. Returns tabs: [{title, sheet_id, index, rows, cols}]. ALWAYS call this first when you don't already know the exact tab name — never guess 'Sheet1'/'Travel' or ask the operator for a tab name you can look up yourself. Defaults to the work expense sheet; pass sheet_id (+ account) for any other sheet.",
    input_schema: {
      type: 'object',
      properties: {
        sheet_id: { type: 'string', description: 'Spreadsheet ID; defaults to work expense sheet' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
    },
  },
  {
    name: 'sheets_read',
    description:
      "Read a range from a Google Sheet. Defaults to the configured work expense sheet (env.EXPENSES_SHEET_ID). Pass sheet_id + account: 'personal' to read other sheets from the personal Drive. If you don't know the tab name, call sheets_info first.",
    input_schema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab name' },
        range: { type: 'string', description: "A1 notation e.g. 'A1:J50'" },
        sheet_id: { type: 'string', description: 'Spreadsheet ID; defaults to work expense sheet' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'drive_upload_invoice',
    description:
      "Save invoice PDF/photo to Drive. Pass file_id from the [ATTACHMENT_REF …] marker. Defaults to work invoices folder; for personal uploads pass account: 'personal' and a folder_id. Returns webViewLink for sheets_append_expense.drive_link.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Telegram file_id from the [ATTACHMENT_REF] marker' },
        file_name: { type: 'string' },
        mime: { type: 'string' },
        vendor: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        category: { type: 'string', enum: ['IT', 'Travel'] },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
        folder_id: { type: 'string', description: 'Drive folder ID; required for personal account' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_list',
    description:
      "Browse Drive (Shared Drives included). Pass folder_id to list a folder's contents, or query to name-search. Omit both for root. Returns folders + files with id/name/kind/link. Use the id as folder_id to drill in, or as file_id for drive_get_file.",
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Drive folder id; omit to list root' },
        query: { type: 'string', description: 'Free-text name substring' },
        max_results: { type: 'integer', default: 25 },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
    },
  },
  {
    name: 'drive_create_folder',
    description: 'Create a folder. Pass parent_id to nest, omit for My Drive root.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['name'],
    },
  },
  {
    name: 'drive_get_file',
    description:
      "Get a Drive file's metadata. include_content:true also pulls text (Docs → plain text, Sheets → CSV, text/* → raw), capped at 12k chars. For binary files, use the link.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        include_content: { type: 'boolean', default: false },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'sheets_create',
    description:
      "Create a new Google Sheet. Optionally pass tabs (array of tab names) and parent_folder_id to place it in a specific Drive folder. Returns sheet_id for sheets_write/sheets_read.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        tabs: { type: 'array', items: { type: 'string' }, description: 'Tab names; defaults to ["Sheet1"]' },
        parent_folder_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['title'],
    },
  },
  {
    name: 'sheets_write',
    description:
      "Write a block of values to a sheet range. OVERWRITES existing cells (use sheets_append_expense for the canonical expense log). values is a 2D array of rows. range defaults to A1. If unsure of the tab name, call sheets_info first.",
    input_schema: {
      type: 'object',
      properties: {
        sheet_id: { type: 'string' },
        tab: { type: 'string' },
        range: { type: 'string', description: "A1 within the tab e.g. 'A1:D10'; defaults to A1" },
        values: {
          type: 'array',
          description: '2D array of row values (string/number/boolean)',
          items: { type: 'array', items: {} },
        },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['sheet_id', 'tab', 'values'],
    },
  },
  {
    name: 'sheets_add_tab',
    description: 'Add a tab (sheet) to an existing spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        sheet_id: { type: 'string' },
        title: { type: 'string', description: 'Tab name' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['sheet_id', 'title'],
    },
  },
  {
    name: 'doc_create',
    description:
      "Create a Google Doc. body is plain text or simple markdown (becomes the doc content). Pass parent_folder_id to place it.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Initial body text' },
        parent_folder_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['title'],
    },
  },
  {
    name: 'doc_append',
    description:
      "Append text to the end of an existing Google Doc. Adds a leading newline so the new content starts on its own line.",
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        text: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['doc_id', 'text'],
    },
  },
  {
    name: 'doc_replace_body',
    description:
      "Replace the entire body of a Doc with new text. Destructive: prior content is gone. Use doc_find_replace for targeted edits.",
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        body: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['doc_id', 'body'],
    },
  },
  {
    name: 'doc_find_replace',
    description:
      "Run one or more find/replace edits on a Doc. Each edit reports how many occurrences it hit. match_case defaults to true.",
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string' },
              replace: { type: 'string' },
              match_case: { type: 'boolean', default: true },
            },
            required: ['find', 'replace'],
          },
        },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['doc_id', 'edits'],
    },
  },
  {
    name: 'drive_rename',
    description: 'Rename a Drive file or folder.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        new_name: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['file_id', 'new_name'],
    },
  },
  {
    name: 'drive_move',
    description:
      'Move a Drive file or folder into new_parent_id. Removes it from its current parent(s).',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        new_parent_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['file_id', 'new_parent_id'],
    },
  },
  {
    name: 'drive_trash',
    description:
      'Move a Drive file or folder to Trash (recoverable from the Drive UI for ~30 days). No permanent-delete tool is exposed to avoid accidents.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_update_content',
    description:
      "Replace the bytes of an existing Drive file with new text content (text/plain, JSON, CSV, markdown). For Google-native types (Docs/Sheets/Slides) use doc_replace_body or sheets_write instead.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        body: { type: 'string', description: 'New file contents' },
        mime: { type: 'string', description: 'Content-Type; defaults to text/plain' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['file_id', 'body'],
    },
  },
  {
    name: 'github_code_search',
    description: 'GitHub code search. Defaults to env.GITHUB_DEFAULT_REPO.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GitHub code search query' },
        repo: { type: 'string', description: 'owner/name, optional' },
        max_results: { type: 'integer', default: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_file_get',
    description: 'Fetch a file from a repo by path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string', description: 'Branch or sha' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_repo_stats',
    description:
      'Repo stats in one call: language byte breakdown, estimated LOC (±20%), stars, issues, last push. Use for "how big / how many lines". Defaults to env.GITHUB_DEFAULT_REPO.',
    input_schema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/name, optional' } },
    },
  },
  {
    name: 'github_issue_search',
    description: 'Search issues and PRs.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        repo: { type: 'string' },
        max_results: { type: 'integer', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'calendar_list_calendars',
    description:
      "Discovery: list every calendar visible to this account, including shared ones (e.g. teammates who shared their calendar to your work account). Returns id (use as calendar_id), name, primary, access_role. Run this once when the operator asks about someone else's schedule and you don't yet know their calendar id.",
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
    },
  },
  {
    name: 'calendar_list_events',
    description:
      "List events. account: 'work' (default) or 'personal'. calendar_id: 'primary' (default) or a specific id from calendar_list_calendars (e.g. a teammate's shared calendar). Default range now→+7d. search filters by text/attendee. Show times in the operator's timezone.",
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'ISO start (optional, defaults to now)' },
        time_max: { type: 'string', description: 'ISO end (optional, defaults to time_min+7d)' },
        search: { type: 'string', description: 'Free-text filter' },
        max_results: { type: 'integer', default: 20 },
        calendar_id: { type: 'string', default: 'primary' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
    },
  },
  {
    name: 'calendar_create_event',
    description:
      "Create event. account: 'work' or 'personal'. ISO 8601 with offset e.g. '2026-06-09T14:00:00+03:00'. Default 30min if no end given. add_meet_link:true for Meet link.",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        start_iso: { type: 'string' },
        end_iso: { type: 'string' },
        duration_minutes: { type: 'integer' },
        attendees: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        location: { type: 'string' },
        add_meet_link: { type: 'boolean', default: false },
        time_zone: { type: 'string', description: "IANA timezone; defaults to operator's timezone from operator context", default: 'UTC' },
        calendar_id: { type: 'string', default: 'primary' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['summary', 'start_iso'],
    },
  },
  {
    name: 'calendar_delete_event',
    description: "Delete event by id (notifies attendees). Pass the same account you listed from.",
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        calendar_id: { type: 'string', default: 'primary' },
        account: { type: 'string', enum: ['work', 'personal'], default: 'work' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'reminder_set',
    description:
      "Schedule a Telegram ping. when_iso is UTC ISO (convert from the operator's local timezone). Fires within ~1min.",
    input_schema: {
      type: 'object',
      properties: {
        when_iso: { type: 'string', description: 'ISO 8601 in UTC, e.g. 2026-06-09T08:00:00Z' },
        message: { type: 'string', description: "What to say back to the operator when it fires" },
      },
      required: ['when_iso', 'message'],
    },
  },
  {
    name: 'reminder_list',
    description: 'List pending reminders.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reminder_cancel',
    description: 'Cancel reminder by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'history_search',
    description:
      "Keyword-search the operator's past chat history archive (beyond the in-context window). Returns matching turns with date, role, text snippet, and tool calls used. days_back defaults to 30. Use when the operator references something earlier than the recent window (\"what did we decide about X last week?\", \"the doc we created in May\").",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to match in message text or tool inputs' },
        days_back: { type: 'integer', description: 'How far back to look in days (default 30, max 365)' },
        max_results: { type: 'integer', description: 'Max matching turns to return (default 20, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'history_read_range',
    description:
      "Read the full chat archive between two dates (inclusive). Use when the operator asks about a specific day/week (\"what happened on the 3rd?\", \"replay tuesday\"). Date range capped at 60 days; turns capped at max_turns (default 100).",
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        to_date: { type: 'string', description: 'YYYY-MM-DD inclusive; defaults to from_date' },
        max_turns: { type: 'integer', description: 'Max turns to return (default 100, max 500)' },
      },
      required: ['from_date'],
    },
  },
  {
    name: 'memory_view',
    description: 'Full content of a memory by name (from the index).',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The kebab-case memory name from the index' } },
      required: ['name'],
    },
  },
  {
    name: 'memory_save',
    description:
      "Save/update a memory. Same name updates. Kebab-case name. Description is one line for the index. High bar: only save if it will change a future reply, isn't already in the index (update the existing entry if it overlaps — don't create near-duplicates or 'extended-X' variants), is durable (not a one-off event), and came from the operator's own words. Default is don't save.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case slug, stable across updates' },
        description: { type: 'string', description: 'One-line summary shown in the memory index' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            "user: about the operator themselves / role / preferences. feedback: rules they've given that shape your replies. project: ongoing initiative/decision state. reference: pointer to a tool/sheet/dashboard/account.",
        },
        content: { type: 'string', description: 'Markdown body. For feedback/project, lead with the rule/fact then **Why:** and **How to apply:** lines.' },
      },
      required: ['name', 'description', 'type', 'content'],
    },
  },
  {
    name: 'memory_bulk_save',
    description:
      'Save many memories in one call. Use when ingesting an exported batch (e.g. from another assistant) instead of looping memory_save.',
    input_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description: 'Array of {name, description, type, content}',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
              content: { type: 'string' },
            },
            required: ['name', 'description', 'type', 'content'],
          },
        },
      },
      required: ['entries'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

export function getToolDefinitions(): ToolDefinition[] {
  return TOOLS;
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  console.log(`[tool] ${name}(${JSON.stringify(input).slice(0, 200)})`);
  switch (name) {
    case 'gmail_search':
      return gmailSearch(
        ctx.env,
        String(input.query),
        Number(input.max_results ?? 10),
        (input.account as 'work' | 'personal') ?? 'work',
      );
    case 'gmail_search_both':
      return gmailSearchBoth(
        ctx.env,
        String(input.query),
        Number(input.max_results ?? 10),
      );
    case 'gmail_read':
      return gmailRead(
        ctx.env,
        String(input.message_id),
        (input.account as 'work' | 'personal') ?? 'work',
        Number(input.offset ?? 0),
      );
    case 'gmail_get_attachment':
      return gmailGetAttachment(
        ctx.env,
        String(input.message_id),
        String(input.attachment_id),
        (input.account as 'work' | 'personal') ?? 'work',
        input.filename ? String(input.filename) : '',
        input.mime_type ? String(input.mime_type) : '',
      );
    case 'sheets_append_expense':
      return sheetsAppendExpense(ctx.env, input as unknown as Parameters<typeof sheetsAppendExpense>[1]);
    case 'finance_log':
      return financeLog(ctx.env, input as unknown as Parameters<typeof financeLog>[1]);
    case 'sheets_info':
      return sheetsInfo(ctx.env, input as unknown as Parameters<typeof sheetsInfo>[1]);
    case 'sheets_read':
      return sheetsRead(ctx.env, input as unknown as Parameters<typeof sheetsRead>[1]);
    case 'drive_upload_invoice':
      return driveUploadInvoice(ctx.env, input as unknown as Parameters<typeof driveUploadInvoice>[1]);
    case 'drive_list':
      return driveList(ctx.env, input as Parameters<typeof driveList>[1]);
    case 'drive_create_folder':
      return driveCreateFolder(ctx.env, input as unknown as Parameters<typeof driveCreateFolder>[1]);
    case 'drive_get_file':
      return driveGetFile(ctx.env, input as unknown as Parameters<typeof driveGetFile>[1]);
    case 'sheets_create':
      return sheetsCreate(ctx.env, input as unknown as Parameters<typeof sheetsCreate>[1]);
    case 'sheets_write':
      return sheetsWrite(ctx.env, input as unknown as Parameters<typeof sheetsWrite>[1]);
    case 'sheets_add_tab':
      return sheetsAddTab(ctx.env, input as unknown as Parameters<typeof sheetsAddTab>[1]);
    case 'doc_create':
      return docCreate(ctx.env, input as unknown as Parameters<typeof docCreate>[1]);
    case 'doc_append':
      return docAppend(ctx.env, input as unknown as Parameters<typeof docAppend>[1]);
    case 'doc_replace_body':
      return docReplaceBody(ctx.env, input as unknown as Parameters<typeof docReplaceBody>[1]);
    case 'doc_find_replace':
      return docFindReplace(ctx.env, input as unknown as Parameters<typeof docFindReplace>[1]);
    case 'drive_rename':
      return driveRename(ctx.env, input as unknown as Parameters<typeof driveRename>[1]);
    case 'drive_move':
      return driveMove(ctx.env, input as unknown as Parameters<typeof driveMove>[1]);
    case 'drive_trash':
      return driveTrash(ctx.env, input as unknown as Parameters<typeof driveTrash>[1]);
    case 'drive_update_content':
      return driveUpdateContent(ctx.env, input as unknown as Parameters<typeof driveUpdateContent>[1]);
    case 'github_code_search':
      return githubCodeSearch(ctx.env, input as unknown as Parameters<typeof githubCodeSearch>[1]);
    case 'github_file_get':
      return githubFileGet(ctx.env, input as unknown as Parameters<typeof githubFileGet>[1]);
    case 'github_repo_stats':
      return githubRepoStats(ctx.env, input as Parameters<typeof githubRepoStats>[1]);
    case 'github_issue_search':
      return githubIssueSearch(ctx.env, input as unknown as Parameters<typeof githubIssueSearch>[1]);
    case 'calendar_list_calendars':
      return calendarListCalendars(ctx.env, input as Parameters<typeof calendarListCalendars>[1]);
    case 'calendar_list_events':
      return calendarListEvents(ctx.env, input as Parameters<typeof calendarListEvents>[1]);
    case 'calendar_create_event':
      return calendarCreateEvent(ctx.env, input as unknown as Parameters<typeof calendarCreateEvent>[1]);
    case 'calendar_delete_event':
      return calendarDeleteEvent(ctx.env, input as unknown as Parameters<typeof calendarDeleteEvent>[1]);
    case 'reminder_set':
      return reminderSet(ctx.env, {
        when_iso: String(input.when_iso),
        message: String(input.message),
        chat_id: ctx.chat_id,
      });
    case 'reminder_list':
      return reminderList(ctx.env);
    case 'reminder_cancel':
      return reminderCancel(ctx.env, String(input.id));
    case 'history_search':
      return searchTranscripts(ctx.env, {
        chat_id: ctx.chat_id,
        query: String(input.query),
        days_back: input.days_back as number | undefined,
        max_results: input.max_results as number | undefined,
      });
    case 'history_read_range':
      return readTranscriptRange(ctx.env, {
        chat_id: ctx.chat_id,
        from_date: String(input.from_date),
        to_date: input.to_date as string | undefined,
        max_turns: input.max_turns as number | undefined,
      });
    case 'memory_view':
      return memoryView(ctx.env, String(input.name));
    case 'memory_save':
      return memorySave(ctx.env, input as {
        name: string;
        description: string;
        type: MemoryType;
        content: string;
      });
    case 'memory_bulk_save':
      return memoryBulkSave(ctx.env, input as Parameters<typeof memoryBulkSave>[1]);
    case 'memory_delete':
      return memoryDelete(ctx.env, String(input.name));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
