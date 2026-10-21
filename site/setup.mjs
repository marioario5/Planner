// One-time setup for building the website on this computer:  cd server && npm run site:setup
//
// Asks for the planner server address, the API token and the site password, and saves them to <repo>/.site-local.env (never committed).
// After that `npm run site:publish` asks for nothing. Run it again any time to change a value; Enter keeps what is already saved.

import { chmodSync, writeFileSync } from 'node:fs';
import { askHidden, askVisible } from './ask.mjs';
import { LOCAL_CONFIG_PATH, formatLocalConfig, loadLocalConfig } from './localconfig.mjs';

const saved = loadLocalConfig();
const keep = (key) => (saved[key] ? ' (Enter keeps the saved one)' : '');

const url = (await askVisible(`Planner server address (https://...)${keep('SITE_URL')}: `)).trim() || saved.SITE_URL || '';
const token = (await askHidden(`Planner API token${keep('SITE_TOKEN')}: `)).trim() || saved.SITE_TOKEN || '';
const password = (await askHidden(`Site password${keep('SITE_PASSWORD')} (Enter on an empty one saves none, so the build asks each time): `)) || saved.SITE_PASSWORD || '';

if (!url || !token) {
  console.error('\nThe address and the token are both needed. Nothing was saved.');
  process.exit(1);
}
writeFileSync(LOCAL_CONFIG_PATH, formatLocalConfig({ SITE_URL: url, SITE_TOKEN: token, SITE_PASSWORD: password }));
try {
  chmodSync(LOCAL_CONFIG_PATH, 0o600); // owner only, where the system supports it
} catch {
  // Windows ignores this; the file sits in your own profile folder
}
console.log(`\nSaved to ${LOCAL_CONFIG_PATH}`);
console.log(`Address: ${url}`);
console.log(`Token length: ${token.length} characters. Password length: ${password.length} characters${password ? '' : ' (not saved: the build will ask)'}.`);
console.log('Next: npm run site:publish');
