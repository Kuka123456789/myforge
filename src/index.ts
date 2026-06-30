import { runAgent } from './claude';
import { loadIndex, renderIndexAsContext } from './memory';
import { handleTestRequest } from './test-endpoint';
import { beginAuthFlow, handleOAuthStart, handleOAuthCallback } from './tools/google-oauth-web';
import { fireDueReminders, listReminders } from './reminders';
import { clearHistory, loadHistory, saveHistory } from './state';
import { appendTurns } from './transcripts';
import {
  BASE_PROMPT,
  appendCustomRule,
  clearCustomPrompt,
  getCustomPrompt,
  getEffectivePrompt,
  setCustomPrompt,
} from './system-prompt';
import {
  fetchTelegramFile,
  sendChatAction,
  sendMessage,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram';
import type { ClaudeContentBlock, ClaudeMessage } from './types';
import { transcribeVoice } from './voice';

interface WorkersAi {
  run(model: string, input: { audio: number[] }): Promise<{ text: string }>;
}

export interface Env {
  STATE: KVNamespace;
  TRANSCRIPTS: R2Bucket;
  AI: WorkersAi;
  MESSAGES: Queue<TelegramUpdate>;

  // Vars
  CLAUDE_MODEL: string;
  MAX_TURNS: string;
  HISTORY_LIMIT: string;
  WORKER_ORIGIN: string;

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID_PERSONAL?: string;
  GOOGLE_CLIENT_SECRET_PERSONAL?: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_REFRESH_TOKEN_PERSONAL: string;
  GITHUB_TOKEN: string;
  GITHUB_DEFAULT_REPO: string;
  EXPENSES_SHEET_ID: string;
  EXPENSES_IT_TAB: string;
  EXPENSES_TRAVEL_TAB: string;
  // Personal Finance Ledger sheet (personal Google account). Optional — falls back
  // to the built-in default ID in tools/finance.ts when unset.
  FINANCE_SHEET_ID?: string;
  INVOICES_DRIVE_FOLDER_ID: string;
  TEST_SECRET: string;
  // Operator profile injected into the system prompt at runtime so the public
  // repo can ship generic. See README "Operator context" section.
  OWNER_CONTEXT: string;
  // IANA timezone for displaying reminders and as the calendar default.
  OPERATOR_TIMEZONE: string;
}

export default {
  // Webhook just acks fast and enqueues. All heavy work runs in queue() below
  // where we get up to 15 minutes per invocation instead of 30s waitUntil cap.
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Developer test endpoint — drive the bot synchronously without Telegram.
    if (url.pathname === '/test' && req.method === 'POST') {
      return handleTestRequest(req, env);
    }

    // Google OAuth web flow — kicked off by `/auth` in Telegram, completes here.
    if (url.pathname === '/oauth/start' && req.method === 'GET') {
      return handleOAuthStart(req, env);
    }
    if (url.pathname === '/oauth/callback' && req.method === 'GET') {
      return handleOAuthCallback(req, env);
    }

    if (req.method !== 'POST') return new Response('ok', { status: 200 });

    let update: TelegramUpdate;
    try {
      update = (await req.json()) as TelegramUpdate;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) return new Response('no message', { status: 200 });

    if (String(msg.chat.id) !== env.TELEGRAM_ALLOWED_CHAT_ID) {
      return new Response('forbidden', { status: 200 });
    }

    // Optimistic typing dot so the user sees acknowledgement even before
    // the queue consumer picks up.
    sendChatAction(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'typing').catch(() => {});

    await env.MESSAGES.send(update);
    return new Response('ok', { status: 200 });
  },

  // Queue consumer: 15-minute invocation budget. Where the real work happens.
  async queue(batch: MessageBatch<TelegramUpdate>, env: Env): Promise<void> {
    for (const queueMsg of batch.messages) {
      const update = queueMsg.body;
      const msg = update.message ?? update.edited_message;
      if (!msg) {
        queueMsg.ack();
        continue;
      }

      try {
        await handleMessage(msg, env);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[queue] handler error:', errMsg, err instanceof Error ? err.stack : '');
        try {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            msg.chat.id,
            `❌ Something broke: ${errMsg}`,
          );
        } catch (e2) {
          console.error('[queue] failed to even report the error:', e2);
        }
      }
      // ack regardless — retrying would just hit the same error or spam.
      queueMsg.ack();
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await fireDueReminders(env.STATE, env.TELEGRAM_BOT_TOKEN);
    if (result.fired > 0) {
      console.log(`fired ${result.fired} reminder(s), ${result.remaining} pending`);
    }
  },
} satisfies ExportedHandler<Env, TelegramUpdate>;

async function handleMessage(msg: TelegramMessage, env: Env): Promise<void> {
  const rawText = msg.text ?? msg.caption ?? '';
  console.log(`[handler] chat=${msg.chat.id} msg_id=${msg.message_id} text="${rawText.slice(0, 80)}" voice=${!!msg.voice} doc=${!!msg.document} photo=${!!msg.photo}`);

  // Slash commands — handled inline, no Claude round trip.
  if (rawText.startsWith('/')) {
    if (await handleSlashCommand(rawText.trim(), msg, env)) return;
  }

  await sendChatAction(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'typing');

  const userContent = await buildUserContent(msg, env);
  if (userContent.length === 0) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      msg.chat.id,
      "I didn't catch anything — text, photo, PDF or voice note all work.",
    );
    return;
  }

  // <today> rides in the user message (cheap, changes daily, doesn't bust cache).
  // Memory index goes into the system prompt via runAgent so it's cached.
  const memoryIndex = await loadIndex(env.STATE);
  const memoryBlock = renderIndexAsContext(memoryIndex);
  const today = new Date().toISOString().slice(0, 10);
  const enrichedContent: ClaudeContentBlock[] = [
    { type: 'text', text: `<today>${today}</today>` },
    ...userContent,
  ];

  const history = await loadHistory(env.STATE, msg.chat.id);
  const messages: ClaudeMessage[] = [...history, { role: 'user', content: enrichedContent }];

  // Telegram typing indicator self-clears after 5s. Refresh just inside that window.
  const typingTimer = setInterval(() => {
    sendChatAction(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'typing').catch(() => {});
  }, 4500);

  try {
    const result = await runAgent({
      env,
      messages,
      maxTurns: parseInt(env.MAX_TURNS, 10) || 10,
      chat_id: msg.chat.id,
      memoryBlock,
      // Stage progress: send a one-line update to Telegram each time Claude
      // calls tools. Fire-and-forget so it doesn't slow processing.
      onProgress: (text) => {
        sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text).catch((e) => {
          console.error('[handler] progress send failed:', e);
        });
      },
    });
    console.log(`[handler] claude done, reply_len=${result.reply.length} preview="${result.reply.slice(0, 100)}"`);

    await sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, result.reply, { replyTo: msg.message_id });
    console.log(`[handler] sendMessage ok to chat=${msg.chat.id}`);

    const userTurn: ClaudeMessage = { role: 'user', content: enrichedContent };
    const assistantTurn: ClaudeMessage = { role: 'assistant', content: result.assistantBlocks };
    const updated = [...messages, assistantTurn];
    await saveHistory(env.STATE, msg.chat.id, updated, parseInt(env.HISTORY_LIMIT, 10) || 12);
    // Archive both turns to R2 for long-term searchable history. Must be
    // awaited: Cloudflare cancels unawaited promises once the queue handler
    // returns, so a fire-and-forget here was silently dropped.
    try {
      await appendTurns(env, msg.chat.id, [userTurn, assistantTurn]);
    } catch (e) {
      console.error('[handler] transcript append failed:', e);
    }
  } finally {
    clearInterval(typingTimer);
  }
}

/** Returns true if the message was a recognised slash command and was handled. */
async function handleSlashCommand(text: string, msg: TelegramMessage, env: Env): Promise<boolean> {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  switch (cmd) {
    case '/new':
    case '/clear':
    case '/reset': {
      await clearHistory(env.STATE, msg.chat.id);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, '✓ Conversation cleared. Long-term memory kept.');
      return true;
    }
    case '/memories':
    case '/memory': {
      const index = await loadIndex(env.STATE);
      if (index.length === 0) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'No memories saved yet.');
      } else {
        const lines = index.map((m) => `• [${m.type}] ${m.name} — ${m.description}`);
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          msg.chat.id,
          `${index.length} memories:\n\n${lines.join('\n')}`,
        );
      }
      return true;
    }
    case '/reminders': {
      const list = await listReminders(env.STATE);
      if (list.length === 0) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'No pending reminders.');
      } else {
        const lines = list.map(
          (r) => `• ${r.id} — ${new Date(r.when_iso).toLocaleString('en-GB', { timeZone: env.OPERATOR_TIMEZONE || 'UTC' })} — ${r.message}`,
        );
        await sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, `${list.length} reminders:\n\n${lines.join('\n')}`);
      }
      return true;
    }
    case '/system':
    case '/prompt': {
      const sub = text.slice(cmd.length).trim();
      return handleSystemCommand(sub, msg, env);
    }
    case '/auth': {
      const sub = text.slice(cmd.length).trim().toLowerCase();
      const account: 'work' | 'personal' | null =
        sub === 'work' ? 'work' : sub === 'personal' ? 'personal' : null;
      if (!account) {
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          msg.chat.id,
          'Usage: /auth work  or  /auth personal\n\nGenerates a one-time sign-in link to re-link the Google account when its refresh token has expired.',
        );
        return true;
      }
      const link = await beginAuthFlow(env, env.WORKER_ORIGIN, account);
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        msg.chat.id,
        `Tap to re-link your ${account} Google account (valid for 10 minutes):\n\n${link}\n\nSign in with the ${account} Google account and approve the scopes. You'll see a confirmation page when it's done.`,
      );
      return true;
    }
    case '/help':
    case '/start': {
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        msg.chat.id,
        [
          'MyForge — your personal AI assistant.',
          '',
          'What I can do:',
          '• Triage Gmail, summarise emails',
          '• Search/query your default GitHub repo',
          '• Log expenses from invoices (send PDF/photo)',
          '• Read/create calendar events',
          '• Set reminders ("remind me Friday at 9am to follow up with X")',
          '• Aggregate data (Python sandbox), web search current facts',
          '• Remember things you tell me, forever',
          '',
          'Commands:',
          '• /new — clear this conversation (memory stays)',
          '• /memories — show what I remember',
          '• /reminders — show pending reminders',
          '• /system — view system prompt (full / base / custom)',
          '• /system add <rule> — append a rule to your custom prompt',
          '• /system set <text> — replace your custom prompt',
          '• /system clear — wipe custom additions, back to base',
          '• /auth work | personal — re-link a Google account (when its login expires)',
          '• /help — this',
          '',
          'You can also send me voice notes — I transcribe and act on them.',
        ].join('\n'),
      );
      return true;
    }
    default:
      return false;
  }
}

async function handleSystemCommand(sub: string, msg: TelegramMessage, env: Env): Promise<true> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;

  // Parse: "<verb> <rest>" or just "<verb>".
  const [verb] = sub.split(/\s+/);
  const argText = sub.slice(verb.length).trim();

  if (!verb) {
    // No subcommand → show full effective prompt.
    const full = await getEffectivePrompt(env.STATE, env.OWNER_CONTEXT);
    await sendMessage(token, chatId, `EFFECTIVE PROMPT (${full.length} chars):\n\n${full}`);
    return true;
  }

  switch (verb.toLowerCase()) {
    case 'base':
      await sendMessage(token, chatId, `BASE PROMPT (${BASE_PROMPT.length} chars, immutable):\n\n${BASE_PROMPT}`);
      return true;

    case 'custom': {
      const custom = await getCustomPrompt(env.STATE);
      if (!custom) {
        await sendMessage(token, chatId, 'No custom additions. Base prompt is in effect. Add one with `/system add <rule>`.');
      } else {
        await sendMessage(token, chatId, `CUSTOM ADDITIONS (${custom.length} chars):\n\n${custom}`);
      }
      return true;
    }

    case 'add':
    case 'append': {
      if (!argText) {
        await sendMessage(token, chatId, 'Usage: /system add <rule>');
        return true;
      }
      const next = await appendCustomRule(env.STATE, argText);
      await sendMessage(token, chatId, `✓ Added. Custom additions now ${next.length} chars. The next reply will use the updated prompt (after cache TTL, ~5 min for full effect).`);
      return true;
    }

    case 'set':
    case 'replace': {
      if (!argText) {
        await sendMessage(token, chatId, 'Usage: /system set <text>  — replaces all your custom additions.');
        return true;
      }
      await setCustomPrompt(env.STATE, argText);
      await sendMessage(token, chatId, `✓ Custom prompt replaced (${argText.length} chars).`);
      return true;
    }

    case 'clear':
    case 'reset': {
      await clearCustomPrompt(env.STATE);
      await sendMessage(token, chatId, '✓ Custom prompt cleared. Back to base.');
      return true;
    }

    default:
      await sendMessage(
        token,
        chatId,
        [
          'Unknown /system subcommand. Try:',
          '• /system — show effective prompt',
          '• /system base — show base prompt',
          '• /system custom — show your additions',
          '• /system add <rule> — append a rule',
          '• /system set <text> — replace your additions',
          '• /system clear — wipe additions',
        ].join('\n'),
      );
      return true;
  }
}

async function buildUserContent(msg: TelegramMessage, env: Env): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [];

  if (msg.voice) {
    const file = await fetchTelegramFile(env.TELEGRAM_BOT_TOKEN, msg.voice.file_id);
    try {
      const transcript = await transcribeVoice(env.AI, file.bytes);
      blocks.push({
        type: 'text',
        text: `[Voice note transcript]: ${transcript || '(empty)'}`,
      });
    } catch (err) {
      blocks.push({
        type: 'text',
        text: `[Voice note received but transcription failed: ${err instanceof Error ? err.message : String(err)}]`,
      });
    }
  }

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b));
    const file = await fetchTelegramFile(env.TELEGRAM_BOT_TOKEN, largest.file_id);
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg',
        data: arrayBufferToBase64(file.bytes),
      },
    });
  }

  if (msg.document) {
    const file = await fetchTelegramFile(env.TELEGRAM_BOT_TOKEN, msg.document.file_id);
    const mime = msg.document.mime_type ?? file.mimeType;
    if (mime === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: arrayBufferToBase64(file.bytes),
        },
      });
    } else if (mime.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: arrayBufferToBase64(file.bytes) },
      });
    } else {
      blocks.push({
        type: 'text',
        text: `[Attached an unsupported file: ${msg.document.file_name ?? 'unknown'} (${mime}). Ask the user to resend as PDF or image if it matters.]`,
      });
    }
    blocks.push({
      type: 'text',
      text: `[ATTACHMENT_REF file_id=${msg.document.file_id} file_name=${msg.document.file_name ?? 'invoice.pdf'} mime=${mime}]`,
    });
  }

  const text = msg.text ?? msg.caption;
  if (text) {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
