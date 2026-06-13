// Google OAuth — refresh access tokens on demand. Per-account caching in KV.
//
// Two accounts supported:
//   'work'     → GOOGLE_REFRESH_TOKEN          (your work Google account)
//   'personal' → GOOGLE_REFRESH_TOKEN_PERSONAL (your personal Google account)
//
// Same OAuth client + secret covers both; only the refresh_token differs.

import type { Env } from '../index';

export type GoogleAccount = 'work' | 'personal';

const SAFETY_MARGIN_S = 60 * 10;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// Refresh token resolution: KV (set by the /oauth web flow) wins over the
// env secret bootstrapped on first install. That way a re-auth via `/auth`
// in Telegram takes effect immediately, without `wrangler secret put`.
async function refreshTokenFor(env: Env, account: GoogleAccount): Promise<string> {
  const fromKv = await env.STATE.get(`google:refresh_token:${account}`);
  if (fromKv) return fromKv;
  if (account === 'personal') {
    if (!env.GOOGLE_REFRESH_TOKEN_PERSONAL) {
      throw new Error("Personal account isn't configured. Run /auth personal in Telegram.");
    }
    return env.GOOGLE_REFRESH_TOKEN_PERSONAL;
  }
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Work account isn't configured. Run /auth work in Telegram.");
  }
  return env.GOOGLE_REFRESH_TOKEN;
}

// Per-account OAuth client. The work account uses a client with full Drive
// scope; the personal account uses a separate (limited) OAuth client because
// Google blocks Drive (restricted) on consumer Gmail without paid app
// verification. Falls back to GOOGLE_CLIENT_ID/SECRET if the per-account
// variant isn't set.
function clientFor(env: Env, account: GoogleAccount): { id: string; secret: string } {
  if (account === 'personal') {
    return {
      id: env.GOOGLE_CLIENT_ID_PERSONAL || env.GOOGLE_CLIENT_ID,
      secret: env.GOOGLE_CLIENT_SECRET_PERSONAL || env.GOOGLE_CLIENT_SECRET,
    };
  }
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

export async function getGoogleAccessToken(
  env: Env,
  account: GoogleAccount = 'work',
  opts: { skipCache?: boolean } = {},
): Promise<string> {
  const cacheKey = `google:access_token:${account}`;
  const cached = opts.skipCache
    ? null
    : ((await env.STATE.get(cacheKey, 'json')) as CachedToken | null);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - SAFETY_MARGIN_S > now) {
    return cached.accessToken;
  }

  const client = clientFor(env, account);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: await refreshTokenFor(env, account),
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed for ${account} (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = now + data.expires_in;

  await env.STATE.put(cacheKey, JSON.stringify({ accessToken: data.access_token, expiresAt }), {
    expirationTtl: data.expires_in,
  });

  return data.access_token;
}

export async function googleFetch(
  env: Env,
  url: string,
  init: RequestInit = {},
  account: GoogleAccount = 'work',
): Promise<Response> {
  const token = await getGoogleAccessToken(env, account);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    throw new Error(
      `Google API returned 401 for ${account} account — refresh token may be invalid or missing scopes. Send "/auth ${account}" to the bot to re-link.`,
    );
  }
  return res;
}
