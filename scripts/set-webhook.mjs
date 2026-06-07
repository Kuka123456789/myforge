#!/usr/bin/env node
// Register the Cloudflare Worker URL as the Telegram bot webhook.
// Usage:
//   TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs https://personal-assistant.<your-subdomain>.workers.dev
//   node scripts/set-webhook.mjs --info     (shows current webhook)
//   node scripts/set-webhook.mjs --delete   (clears webhook)

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN env var required');
  process.exit(1);
}

const arg = process.argv[2];

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

if (arg === '--info' || arg === '-i') {
  console.log(JSON.stringify(await api('getWebhookInfo'), null, 2));
} else if (arg === '--delete' || arg === '-d') {
  console.log(JSON.stringify(await api('deleteWebhook', { drop_pending_updates: true }), null, 2));
} else if (arg && arg.startsWith('http')) {
  const result = await api('setWebhook', {
    url: arg,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error('Usage: node scripts/set-webhook.mjs <worker-url> | --info | --delete');
  process.exit(1);
}
