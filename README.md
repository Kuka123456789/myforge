# MyForge

A personal AI assistant on Telegram, hosted on Cloudflare Workers. Reads/writes work + personal Gmail/Sheets/Drive/Calendar, searches GitHub, runs Python in a sandbox, sets reminders, remembers things across conversations.

```
Telegram → Cloudflare Worker (fetch handler, fast ack)
            ↓ enqueue
          Cloudflare Queue (myforge-messages)
            ↓ consumer (up to 15-min budget)
          Claude API ←→ tools (Gmail, Sheets, Drive, Calendar, GitHub, memory, code_execution, web_search)
            ↓
          Telegram reply
```

- **Always-on**, runs at the edge.
- **Allowlist of one chat**: only the configured Telegram chat ID gets through.
- **Workers Paid** plan required (CPU + subrequest limits, Queues, Workers AI Whisper for voice notes).
- Anthropic API-key billing (NOT Max OAuth, which is against ToS for third-party agents).
- Cost: ~$5–15/mo at typical use (Anthropic tokens; Cloudflare ~$5/mo base; Telegram free).

## Operator context

The system prompt that ships in this repo is **owner-agnostic**. It describes a generic personal assistant. To make the bot behave for you specifically (your name, role, account routing rules, default GitHub repo, paid_by values for your expense sheet, etc.), you set an `OWNER_CONTEXT` secret containing a free-form profile that gets appended to the prompt at runtime.

Example `OWNER_CONTEXT` value:

```
Operator: Jane Smith, Head of Engineering at Acme.
Lives in London; writes British English.

Account routing:
- Acme/clients/team → work
- Banking/family/personal subs → personal
- Travel/bookings → search BOTH via gmail_search_both

Expense sheet paid_by values: 'Jane', 'Co-Founder', 'Company'.
Default GitHub repo: acme/main-app.
```

This is set via `npx wrangler secret put OWNER_CONTEXT` (see step 7 below).

## Files & directories

```
src/
  index.ts              Worker entrypoint: fetch handler, queue consumer, scheduled (cron), slash commands
  claude.ts             Agentic Claude tool-use loop. onProgress callback for stage messages.
  state.ts              KV-backed per-chat conversation history (7-day TTL).
  memory.ts             KV-backed long-term memory store + index rendering.
  system-prompt.ts      Generic BASE prompt + OWNER_CONTEXT injection + KV-stored custom additions.
  reminders.ts          Cron-fired reminder dispatcher.
  voice.ts              Workers AI Whisper transcription for voice notes.
  telegram.ts           Telegram Bot API client.
  test-endpoint.ts      /test endpoint: drive the bot from a developer machine without Telegram.
  types.ts              Anthropic content block types.
  tools/
    google-auth.ts      Per-account OAuth refresh + cached access tokens. Multi-account: googleFetch takes account param.
    gmail.ts            gmailSearch, gmailSearchBoth, gmailRead (all account-aware)
    sheets.ts           sheetsAppendExpense (work-only), sheetsRead (account+sheet_id)
    drive.ts            driveUploadInvoice (account+folder_id)
    calendar.ts         calendarListEvents, calendarCreateEvent, calendarDeleteEvent (account-aware)
    github.ts           githubCodeSearch, githubFileGet, githubRepoStats, githubIssueSearch
    memory.ts           memoryView, memorySave, memoryBulkSave, memoryDelete
    reminders.ts        reminderSet, reminderList, reminderCancel
    registry.ts         Tool definitions + dispatchTool switch. Logs every call as [tool] ...
scripts/
  bootstrap-google-oauth.mjs   One-time OAuth bootstrap (opens browser).
  set-webhook.mjs              Register Telegram webhook URL.
  set-commands.mjs             Register slash commands (so / autocomplete shows them).
wrangler.toml         Worker config (queue, KV, AI binding, cron, limits).
```

## One-time setup (~20 minutes total)

### 1. Create the Telegram bot

Open Telegram → message **@BotFather** → `/newbot` → pick a name and handle. Save the bot token.

Then `@userinfobot` → save your numeric chat ID (allowlist).

### 2. Google Cloud OAuth client

Create a fresh Google Cloud project under your personal Gmail account:

1. https://console.cloud.google.com/projectcreate → "personal-assistant" → **No organization**
2. Enable APIs: **Gmail API**, **Google Sheets API**, **Google Drive API**, **Google Calendar API**
3. **OAuth consent screen → Branding**: External, "MyForge", your personal Gmail as support email
4. **OAuth consent screen → Data Access → Add scopes**:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/calendar.events`
5. **Audience**: **Publish App** (avoids the 7-day refresh-token expiry of Testing mode)
6. **Credentials → Create OAuth client ID → Desktop app**: "personal-assistant-cli". **Download JSON.**
7. Move to `~/.config/personal-assistant/credentials.json`.

### 3. Mint refresh tokens for BOTH accounts

You need TWO refresh tokens (work + personal) from the SAME OAuth client. Run bootstrap once per account:

```bash
cd <repo>
export GOOGLE_CLIENT_ID="$(jq -r .installed.client_id ~/.config/personal-assistant/credentials.json)"
export GOOGLE_CLIENT_SECRET="$(jq -r .installed.client_secret ~/.config/personal-assistant/credentials.json)"

# First, work account: sign in as your work Gmail
node scripts/bootstrap-google-oauth.mjs
# → saves the printed refresh token; this is GOOGLE_REFRESH_TOKEN

# Then, personal account: sign in as your personal Gmail
node scripts/bootstrap-google-oauth.mjs
# → saves a SECOND refresh token; this is GOOGLE_REFRESH_TOKEN_PERSONAL
```

Each refresh token is bound to the user who clicked through the consent screen.

### 4. GitHub fine-grained PAT

https://github.com/settings/personal-access-tokens/new → name it `myforge`, 1-year expiry, select the org/owner and repo(s) you want searchable, **Contents/Metadata/Issues/PRs Read-only**.

Alternatively use `gh auth token` from your CLI.

### 5. Anthropic API key

https://console.anthropic.com → API Keys → Create. **Tier 2 or above** (Tier 1's 30k input TPM hits limits during real conversations). Top up to ~$40 cumulative spend to auto-upgrade to Tier 2.

### 6. Drive folder for invoices

New folder in the WORK account Drive: "MyForge invoices". Grab the folder ID from the URL.

### 7. Configure Cloudflare and deploy

```bash
cd <repo>
npm install

# KV namespace for conversation/memory/reminders
npx wrangler kv namespace create myforge-state
# → paste the printed id into wrangler.toml [[kv_namespaces]] id

# Queue for async message processing (15-min consumer budget)
npx wrangler queues create myforge-messages

# Secrets, see "Setting secrets safely" below
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN              # WORK refresh token
npx wrangler secret put GOOGLE_REFRESH_TOKEN_PERSONAL     # PERSONAL refresh token
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_DEFAULT_REPO               # e.g. owner/repo
npx wrangler secret put EXPENSES_SHEET_ID
npx wrangler secret put EXPENSES_IT_TAB
npx wrangler secret put EXPENSES_TRAVEL_TAB
npx wrangler secret put INVOICES_DRIVE_FOLDER_ID
npx wrangler secret put OPERATOR_TIMEZONE                 # IANA tz, e.g. Europe/London
npx wrangler secret put OWNER_CONTEXT                     # see "Operator context" above

# Test endpoint secret (lets developers drive the bot without Telegram)
openssl rand -hex 16 | npx wrangler secret put TEST_SECRET

# Deploy
npx wrangler deploy
# → note the workers.dev URL

# Register Telegram webhook + slash commands
TELEGRAM_BOT_TOKEN=<token> node scripts/set-webhook.mjs https://myforge.<sub>.workers.dev
TELEGRAM_BOT_TOKEN=<token> node scripts/set-commands.mjs
```

### Setting secrets safely (read this)

**Do NOT use `printf "%s" "value" | wrangler secret put NAME`**: this has been observed to corrupt or set the wrong value silently (no error). The reason isn't fully understood (possibly stdin buffering, possibly wrangler version-specific), but it can bite hard.

**Safe pattern:**

```bash
# Write to a file, strip newline, pipe through cat
echo "the-secret-value-here" > /tmp/secret.txt
cat /tmp/secret.txt | tr -d '\n' | npx wrangler secret put MY_SECRET
rm /tmp/secret.txt
```

Or use the **interactive prompt** (wrangler asks for the value):

```bash
npx wrangler secret put MY_SECRET
# (paste value when prompted, hit enter)
```

After setting refresh-token secrets, **always run the diag endpoint** (below) to verify the secret actually stored the value you intended.

## Developer tools

### The `/test` endpoint

Lets a developer drive the bot synchronously without going through Telegram. Lives at `https://myforge.<sub>.workers.dev/test`, authenticated via `x-test-secret: <TEST_SECRET>` header.

**Drive the bot:**

```bash
curl -X POST https://myforge.<sub>.workers.dev/test \
  -H "x-test-secret: <your test secret>" \
  -H "content-type: application/json" \
  -d '{"text": "what is on my calendar today?"}' \
  | jq
```

Returns `{ reply, stage_messages }`. Same code path as Telegram (queue handler logic) but synchronous and the reply is returned in the HTTP response.

**Diagnose Google OAuth (verify each refresh token resolves to the right Gmail account):**

```bash
curl -X POST 'https://myforge.<sub>.workers.dev/test?diag=1' \
  -H "x-test-secret: <secret>" -d '{}' | jq
```

If both accounts show the same email, your refresh tokens are misconfigured. Re-run the bootstrap for the wrong-account one and re-set the secret via the safe pattern.

**Dump the suffix of each refresh-token secret (verify what wrangler actually stored):**

```bash
curl -X POST 'https://myforge.<sub>.workers.dev/test?secrets=1' \
  -H "x-test-secret: <secret>" -d '{}' | jq
```

**Raw OAuth refresh probe (bypasses the cache; what does Google actually return for each refresh token right now):**

```bash
curl -X POST 'https://myforge.<sub>.workers.dev/test?oauth=1' \
  -H "x-test-secret: <secret>" -d '{}' | jq
```

### Logs (7-day retention)

Workers Logs is enabled in `wrangler.toml` (`[observability] enabled = true`). View past events:

```bash
# Live tail
npx wrangler tail --format pretty

# Past logs via the Cloudflare dashboard:
# https://dash.cloudflare.com → Workers → myforge → Logs
```

Important log markers:
- `[handler]`: fetch handler entry, Claude reply preview, sendMessage confirmation
- `[tool]`: every tool dispatch with its input arguments
- `[gmail_search]`: per-search result count
- `[queue]`: queue consumer activity, errors

### Clearing caches

OAuth access tokens are cached in KV per account (`google:access_token:<work|personal>`). When you change a refresh-token secret, **clear the cache immediately** (KV is eventually consistent, up to 60 seconds):

```bash
npx wrangler kv key delete --binding=STATE --remote "google:access_token:personal"
npx wrangler kv key delete --binding=STATE --remote "google:access_token:work"
```

Or use the `skipCache: true` option in `getGoogleAccessToken` (the diag endpoint already does this).

## Slash commands (in Telegram)

| Command | What it does |
|---|---|
| `/new` | Clear current conversation (long-term memory kept) |
| `/memories` | List everything in long-term memory |
| `/reminders` | List pending reminders |
| `/system` | Show effective system prompt |
| `/system base` | Show base prompt (immutable from chat) |
| `/system custom` | Show custom additions |
| `/system add <rule>` | Append a rule to your custom prompt |
| `/system set <text>` | Replace custom prompt |
| `/system clear` | Wipe custom additions |
| `/help` | Capability list |

## Multi-account routing

| Tool | Work account | Personal account |
|---|---|---|
| `gmail_search` / `gmail_read` / `gmail_search_both` | yes | yes (pass `account: "personal"`) |
| `calendar_*` | yes (default) | yes (`account: "personal"`) |
| `sheets_read` | yes (default, expense sheet) | yes (`account: "personal"` + `sheet_id`) |
| `drive_upload_invoice` | yes (default, work folder) | yes (`account: "personal"` + `folder_id`) |
| `sheets_append_expense` | yes (only, bespoke for expense sheet) | no |
| `github_*` | n/a (uses PAT) | n/a |

**Routing rules** are set in your `OWNER_CONTEXT` (see top of this README). The base system prompt only knows the abstract concept of work vs personal; your secret tells the model which categories of content go where.

## Troubleshooting

### Bot returns "nothing" for personal-account queries

1. Run `/test?diag=1`: does personal show your personal Gmail address?
2. If both show work: the personal refresh-token secret is wrong. Re-bootstrap (sign in as personal Gmail) and re-set the secret via the safe pattern (file + cat | tr, NOT printf).
3. Clear the access-token caches.

### Bot times out / silent failures

- Older Worker invocations were capped at 30s `waitUntil`. We migrated to Cloudflare Queues (15-minute consumer budget). If you see "waitUntil cancelled", you're on stale code.
- Check Anthropic rate limit (Tier 2 = 80k TPM). Tier 1's 30k is too tight.

### "Something broke: X" replies

The queue consumer catches all errors and surfaces them. The error message tells you what failed:
- `Google API returned 401`: refresh token revoked or scope changed
- `Rate-limited by Anthropic`: bump tier or wait
- `Telegram sendMessage failed`: check `allow_sending_without_reply` is set (it is)
- Anything else: check `wrangler tail` for the stack trace

### KV eventual consistency

KV writes/deletes can take up to **60 seconds** to propagate globally. If you delete a cached token, the next read might still see the old value for ~30 seconds. The diag endpoint uses `skipCache: true` to bypass; for production code, use the `opts.skipCache` parameter.

## Architecture notes

- **NEVER use `printf "%s" "value" | wrangler secret put NAME`** for secrets that contain special characters. Use the file pattern in "Setting secrets safely".
- **Multi-account routing flows through one function:** `googleFetch(env, url, init, account)`. ALL Google tools must pass the `account` parameter explicitly. If you add a new Google tool, plumb `account` through.
- **`/test` is your friend.** Use it to drive the bot directly when debugging.
- **Queue consumer has 15-minute budget,** but every tool call is a subrequest. Workers Paid allows 1000 subrequests per invocation. At ~5 subrequests per tool call (Claude + Telegram + Google APIs), there's plenty of headroom.
- **Memory is BACKGROUND context, not a substitute for tools.** When the user asks to "check email" or "search for X", the bot MUST call the relevant tool: recalling a memory about the topic doesn't fulfil the request.

## Costs

| Item | Cost |
|---|---|
| Cloudflare Workers Paid (CPU, Queues, Workers AI, Logs) | $5/mo base + usage (effectively $5/mo at this volume) |
| Anthropic Claude API (Sonnet 4.6, prompt caching) | ~$5–15/mo |
| Telegram Bot API | $0 |
| Google APIs | $0 (within free tier) |
| GitHub API | $0 (within free tier) |
| **Total** | **~$10–20/mo** |

## License

MIT.
