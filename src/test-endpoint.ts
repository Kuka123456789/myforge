// Test endpoint: lets the developer (Claude Code) drive the bot synchronously
// and see the full picture — tool calls, stage messages, final reply — without
// going through Telegram.
//
// Auth: header `x-test-secret` must match env.TEST_SECRET.
// Body: { text: string, account_hint?: 'work'|'personal' }
// Returns: { reply, stage_messages, tool_calls, error? }

import type { Env } from './index';
import { runAgent } from './claude';
import { loadIndex, renderIndexAsContext } from './memory';
import type { ClaudeContentBlock, ClaudeMessage } from './types';

export async function handleTestRequest(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get('x-test-secret');
  if (!env.TEST_SECRET || provided !== env.TEST_SECRET) {
    return jsonResponse(401, { error: 'bad or missing x-test-secret' });
  }

  const url = new URL(req.url);

  // /test?oauth=1 — raw OAuth refresh response (token call + immediate profile
  // call) for both refresh-token secrets, in parallel. Use to confirm the
  // refresh token in env actually maps to the right Google account.
  if (url.searchParams.get('oauth') === '1') {
    // Per-account OAuth clients: personal uses its own client_id/secret because
    // Google blocks Drive scope on consumer Gmail. Match what google-auth.ts does.
    const clientFor = (acct: 'work' | 'personal') =>
      acct === 'personal'
        ? {
            id: env.GOOGLE_CLIENT_ID_PERSONAL || env.GOOGLE_CLIENT_ID,
            secret: env.GOOGLE_CLIENT_SECRET_PERSONAL || env.GOOGLE_CLIENT_SECRET,
          }
        : { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
    const probe = async (label: 'work' | 'personal', refreshToken: string) => {
      const { id, secret } = clientFor(label);
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: id,
          client_secret: secret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const tokenJson = (await res.json()) as { access_token?: string; scope?: string; expires_in?: number; error?: string; error_description?: string };
      let email: string | null = null;
      if (tokenJson.access_token) {
        const profile = (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { authorization: `Bearer ${tokenJson.access_token}` },
        }).then((r) => r.json())) as { emailAddress?: string };
        email = profile.emailAddress ?? null;
      }
      return {
        label,
        refresh_token_suffix: `...${refreshToken.slice(-20)}`,
        oauth_status: res.status,
        access_token_prefix: tokenJson.access_token?.slice(0, 25) ?? null,
        scope: tokenJson.scope,
        expires_in: tokenJson.expires_in,
        error: tokenJson.error,
        error_description: tokenJson.error_description,
        email_from_profile: email,
      };
    };
    const [w, p] = await Promise.all([
      probe('work', env.GOOGLE_REFRESH_TOKEN),
      probe('personal', env.GOOGLE_REFRESH_TOKEN_PERSONAL),
    ]);
    return jsonResponse(200, { work: w, personal: p, client_id_suffix: `...${env.GOOGLE_CLIENT_ID.slice(-25)}` });
  }

  // /test?secrets=1 — show the SUFFIX of each refresh-token secret. Lets us
  // tell whether wrangler actually stored what we sent it.
  if (url.searchParams.get('secrets') === '1') {
    const tail = (s: string | undefined, n = 20) =>
      s ? `${s.length} chars, ends "...${s.slice(-n)}"` : 'NOT SET';
    return jsonResponse(200, {
      GOOGLE_REFRESH_TOKEN: tail(env.GOOGLE_REFRESH_TOKEN),
      GOOGLE_REFRESH_TOKEN_PERSONAL: tail(env.GOOGLE_REFRESH_TOKEN_PERSONAL),
      same_value: env.GOOGLE_REFRESH_TOKEN === env.GOOGLE_REFRESH_TOKEN_PERSONAL,
    });
  }

  // /test?diag=1 — direct probe: which email does each refresh token actually
  // belong to, and does a sample search return anything? Use skipCache to bypass
  // stale KV.
  if (url.searchParams.get('diag') === '1') {
    const { getGoogleAccessToken } = await import('./tools/google-auth');
    const probe = async (account: 'work' | 'personal') => {
      try {
        const token = await getGoogleAccessToken(env, account, { skipCache: true });
        const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { authorization: `Bearer ${token}` },
        }).then((r) => r.json() as Promise<{ emailAddress?: string; messagesTotal?: number }>);
        const search = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=bookaflight&maxResults=3',
          { headers: { authorization: `Bearer ${token}` } },
        ).then((r) => r.json() as Promise<{ messages?: unknown[]; resultSizeEstimate?: number }>);
        return {
          account,
          emailAddress: profile.emailAddress,
          messagesTotal: profile.messagesTotal,
          token_prefix: token.slice(0, 20),
          search_bookaflight: { returned: search.messages?.length ?? 0, estimate: search.resultSizeEstimate },
        };
      } catch (err) {
        return { account, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const [work, personal] = await Promise.all([probe('work'), probe('personal')]);
    return jsonResponse(200, { work, personal });
  }

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return jsonResponse(400, { error: 'bad JSON body' });
  }
  if (!body.text) return jsonResponse(400, { error: 'text field required' });

  const stageMessages: string[] = [];
  let reply: string;

  // Build user content the same way the real handler does.
  const memoryIndex = await loadIndex(env.STATE);
  const memoryBlock = renderIndexAsContext(memoryIndex);
  const today = new Date().toISOString().slice(0, 10);
  const preface = [`<today>${today}</today>`, memoryBlock].filter(Boolean).join('\n\n');
  const userContent: ClaudeContentBlock[] = [
    { type: 'text', text: preface },
    { type: 'text', text: body.text },
  ];
  const messages: ClaudeMessage[] = [{ role: 'user', content: userContent }];

  try {
    const result = await runAgent({
      env,
      messages,
      maxTurns: parseInt(env.MAX_TURNS, 10) || 10,
      // Test mode uses a fake chat id; reminder_set would refuse on this anyway
      // because of past-date checks.
      chat_id: -1,
      onProgress: (text) => {
        stageMessages.push(text);
      },
    });
    reply = result.reply;
  } catch (err) {
    return jsonResponse(500, {
      error: err instanceof Error ? err.message : String(err),
      stage_messages: stageMessages,
    });
  }

  return jsonResponse(200, {
    reply,
    stage_messages: stageMessages,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
