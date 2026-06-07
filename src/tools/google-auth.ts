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

function refreshTokenFor(env: Env, account: GoogleAccount): string {
  if (account === 'personal') {
    if (!env.GOOGLE_REFRESH_TOKEN_PERSONAL) {
      throw new Error("Personal account isn't configured (GOOGLE_REFRESH_TOKEN_PERSONAL secret not set).");
    }
    return env.GOOGLE_REFRESH_TOKEN_PERSONAL;
  }
  return env.GOOGLE_REFRESH_TOKEN;
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

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshTokenFor(env, account),
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
      `Google API returned 401 for ${account} account — refresh token may be invalid or missing scopes. Re-run the OAuth bootstrap.`,
    );
  }
  return res;
}
