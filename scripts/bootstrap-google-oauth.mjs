#!/usr/bin/env node
// One-time: get a Google OAuth refresh token with the scopes needed for Gmail + Sheets + Drive.
//
// Prereq: in Google Cloud Console, on the OAuth 2.0 Client ID for your existing gspread credentials
// (or a new "Desktop app" client), under "OAuth consent screen" add these scopes:
//   - https://www.googleapis.com/auth/gmail.readonly
//   - https://www.googleapis.com/auth/spreadsheets
//   - https://www.googleapis.com/auth/drive       (full Drive — browse any folder, not just app-created files)
//   - https://www.googleapis.com/auth/documents   (Google Docs read/write)
// And confirm http://localhost:53682/oauth is registered as a redirect URI (Desktop clients accept localhost).
//
// If you previously bootstrapped with drive.file, you MUST re-run this and replace both
// GOOGLE_REFRESH_TOKEN and GOOGLE_REFRESH_TOKEN_PERSONAL — the old tokens won't have drive scope.
//
// Then run:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/bootstrap-google-oauth.mjs
// It will open a browser, you log in, and the refresh_token gets printed at the end.

import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars required');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth`;

// Scope sets. Default = work (full power, restricted-scope; only works for the
// Workspace-internal work account). MINIMAL=1 = personal (gmail + calendar only,
// no Drive, no Sheets — avoids Google's restricted-scope wall on consumer Gmail).
const FULL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
];
const MINIMAL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const SCOPES = process.env.MINIMAL === '1' ? MINIMAL_SCOPES : FULL_SCOPES;
console.log(`Requesting scopes: ${SCOPES.join(', ')}`);

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // force refresh_token even if previously granted
authUrl.searchParams.set('scope', SCOPES.join(' '));

console.log('\nOpen this URL in your browser, sign in, and approve:');
console.log(`\n  ${authUrl.toString()}\n`);

exec(`open "${authUrl.toString()}"`); // macOS — silently no-ops elsewhere

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (reqUrl.pathname !== '/oauth') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const code = reqUrl.searchParams.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end('no code');
    return;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const data = await tokenRes.json();
  if (!data.refresh_token) {
    console.error('\nNo refresh_token in response — Google may have already issued one. Revoke the app at https://myaccount.google.com/permissions and retry.\n', data);
    res.end('No refresh_token returned. See terminal.');
    server.close();
    process.exit(1);
  }

  console.log('\n=== SUCCESS ===');
  console.log(`Refresh token: ${data.refresh_token}`);
  console.log(`Scopes: ${data.scope}`);
  console.log('\nSet this as a Worker secret:');
  console.log(`  npx wrangler secret put GOOGLE_REFRESH_TOKEN`);
  console.log('  (paste the refresh token above when prompted)\n');

  res.end('Got it — check your terminal. You can close this tab.');
  server.close();
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI} for the OAuth redirect…`);
});
