// In-Worker Google OAuth flow. The user taps a link, signs in with Google,
// and the new refresh token gets stored in KV — no terminal, no wrangler.
//
// Flow:
//   1. /auth work  → Telegram handler calls beginAuthFlow() → stores a nonce
//      in KV → returns a short link the user taps.
//   2. /oauth/start?n=<nonce>  → looks up nonce, redirects to Google consent.
//   3. /oauth/callback?code&state  → exchanges code, stores refresh token
//      in KV, clears the cached access token, shows a success page.
//
// Refresh tokens live at  google:refresh_token:<account>  in KV.
// google-auth.ts prefers the KV value over the env secret, so a re-auth
// takes effect on the next request.
//
// The "redirect URI" must be registered in the Google OAuth client (Google
// Cloud Console → Credentials → your OAuth 2.0 Client ID → Authorized
// redirect URIs). The required value is logged on first failure.

import type { Env } from '../index';
import type { GoogleAccount } from './google-auth';

const NONCE_TTL_S = 60 * 10;
const STATE_TTL_S = 60 * 10;

const FULL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const MINIMAL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

function scopesFor(account: GoogleAccount): string[] {
  return account === 'personal' ? MINIMAL_SCOPES : FULL_SCOPES;
}

function clientFor(env: Env, account: GoogleAccount): { id: string; secret: string } {
  if (account === 'personal') {
    return {
      id: env.GOOGLE_CLIENT_ID_PERSONAL || env.GOOGLE_CLIENT_ID,
      secret: env.GOOGLE_CLIENT_SECRET_PERSONAL || env.GOOGLE_CLIENT_SECRET,
    };
  }
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

export function redirectUriFor(workerOrigin: string): string {
  return `${workerOrigin}/oauth/callback`;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Called from the Telegram /auth handler. Returns a one-shot link the user
// can tap. The nonce → {account} mapping is stored in KV with a short TTL.
export async function beginAuthFlow(
  env: Env,
  workerOrigin: string,
  account: GoogleAccount,
): Promise<string> {
  const nonce = randomToken();
  await env.STATE.put(
    `oauth:nonce:${nonce}`,
    JSON.stringify({ account }),
    { expirationTtl: NONCE_TTL_S },
  );
  return `${workerOrigin}/oauth/start?n=${nonce}`;
}

// /oauth/start?n=<nonce>  →  302 to Google consent.
export async function handleOAuthStart(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const nonce = url.searchParams.get('n');
  if (!nonce) return htmlResponse(400, 'Missing <code>n</code> parameter. Ask the bot for a fresh link via <code>/auth work</code> or <code>/auth personal</code>.');

  const stored = (await env.STATE.get(`oauth:nonce:${nonce}`, 'json')) as { account: GoogleAccount } | null;
  if (!stored) return htmlResponse(400, 'This link has expired or was already used. Ask the bot for a fresh one.');

  // Consume the nonce so the link is one-shot.
  await env.STATE.delete(`oauth:nonce:${nonce}`);

  const account = stored.account;
  const client = clientFor(env, account);
  if (!client.id || !client.secret) {
    return htmlResponse(500, `OAuth client for <b>${account}</b> account isn't configured in this Worker.`);
  }

  const state = randomToken();
  await env.STATE.put(
    `oauth:state:${state}`,
    JSON.stringify({ account }),
    { expirationTtl: STATE_TTL_S },
  );

  const redirectUri = redirectUriFor(url.origin);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', client.id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('scope', scopesFor(account).join(' '));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

// /oauth/callback?code=...&state=...  →  exchanges, stores, shows success.
export async function handleOAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return htmlResponse(400, `Google returned an error: <code>${escapeHtml(oauthError)}</code>. Try <code>/auth</code> again from the bot.`);
  }
  if (!code || !state) {
    return htmlResponse(400, 'Missing <code>code</code> or <code>state</code>. This URL is for Google to redirect to, not for opening directly.');
  }

  const stored = (await env.STATE.get(`oauth:state:${state}`, 'json')) as { account: GoogleAccount } | null;
  if (!stored) {
    return htmlResponse(400, 'State expired or unknown. Ask the bot for a fresh <code>/auth</code> link.');
  }
  await env.STATE.delete(`oauth:state:${state}`);

  const account = stored.account;
  const client = clientFor(env, account);
  const redirectUri = redirectUriFor(url.origin);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    const detail = tokenJson.error_description ?? tokenJson.error ?? `HTTP ${tokenRes.status}`;
    return htmlResponse(500, `Token exchange failed: <code>${escapeHtml(detail)}</code>. If Google said "redirect_uri_mismatch", add <code>${escapeHtml(redirectUri)}</code> as an Authorized redirect URI on your OAuth client in Google Cloud Console.`);
  }

  // Confirm the account we got is the one the user picked, by reading their
  // Gmail profile. (We don't error on mismatch — that's overkill for a
  // single-operator bot — but we show it so the user can see what they linked.)
  let linkedEmail: string | null = null;
  if (tokenJson.access_token) {
    try {
      const profile = (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { authorization: `Bearer ${tokenJson.access_token}` },
      }).then((r) => r.json())) as { emailAddress?: string };
      linkedEmail = profile.emailAddress ?? null;
    } catch {
      // best-effort — don't block the save
    }
  }

  // Persist refresh token in KV. google-auth.ts prefers KV over env.
  await env.STATE.put(`google:refresh_token:${account}`, tokenJson.refresh_token);
  // Bust any stale cached access token for this account.
  await env.STATE.delete(`google:access_token:${account}`);

  return htmlResponse(
    200,
    `<h2>✓ ${escapeHtml(account)} account re-linked</h2>
     <p>Refresh token stored. The bot will pick it up on its next call.</p>
     ${linkedEmail ? `<p>Linked Google account: <b>${escapeHtml(linkedEmail)}</b></p>` : ''}
     <p>You can close this tab.</p>`,
  );
}

function htmlResponse(status: number, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>MyForge OAuth</title>
     <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#222;line-height:1.5}h2{margin-top:0}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
     <body>${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
