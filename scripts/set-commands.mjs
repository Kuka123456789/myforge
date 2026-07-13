#!/usr/bin/env node
// Register the bot's slash commands with Telegram so they appear in the
// autocomplete menu when the user types `/`.
//
// Run: TELEGRAM_BOT_TOKEN=... node scripts/set-commands.mjs

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN env var required');
  process.exit(1);
}

const commands = [
  { command: 'new', description: 'Clear this conversation (memory stays)' },
  { command: 'memories', description: 'Show what I remember about you' },
  { command: 'reminders', description: 'Show pending reminders' },
  { command: 'system', description: 'View / edit my system prompt' },
  { command: 'auth', description: 'Re-link a Google account (work | personal)' },
  { command: 'help', description: 'What I can do' },
];

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commands }),
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  process.exit(1);
}
