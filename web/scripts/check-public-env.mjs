import { readFileSync, existsSync } from 'node:fs';

const values = { ...process.env };
for (const file of ['.env', '.env.production', '.env.local', '.env.production.local']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && !values[match[1]]) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const required = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SOLANA_RPC'];
const missing = required.filter((name) => !values[name] ||
  /placeholder|your_|example\.com/i.test(values[name]));
if (missing.length) {
  console.error(`Refusing to export a broken web app. Configure: ${missing.join(', ')}`);
  process.exit(1);
}
for (const name of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SOLANA_RPC']) {
  if (!values[name].startsWith('https://')) {
    console.error(`${name} must use HTTPS in the web app.`);
    process.exit(1);
  }
}
