// Builds the locked planner website into docs/index.html (the folder GitHub Pages serves).
//
//   node site/build.mjs          (or: cd server && npm run site:build)
//
// It asks for three things (nothing is stored; the secrets never go into git):
//   - the planner server address (your Worker, https://...workers.dev)
//   - the planner API token (the same one the phone app uses)
//   - the password that unlocks the site (typed into the search box)
// You can also provide them as SITE_URL, SITE_TOKEN and SITE_PASSWORD environment variables, or save them once in the private file
// .site-local.env at the top of the repo (never committed) with: cd server && npm run site:setup
// Before writing anything it checks that the server really accepts the token.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askHidden, askVisible } from './ask.mjs';
import { buildSite } from './build-lib.mjs';
import { LOCAL_CONFIG_PATH, loadLocalConfig } from './localconfig.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function checkServer(url, token) {
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/tasks', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('the server rejected that token (401): check it against the phone app');
    if (res.status !== 200) console.warn(`\nNote: the server answered ${res.status} when checking the token.`);
  } catch (err) {
    if (String(err.message).startsWith('the server rejected')) throw err;
    console.warn(`\nNote: couldn't reach the server to check the token (${err.message}). Building anyway.`);
  }
}

// Where each value comes from, in order: an environment variable, then the private file <repo>/.site-local.env (made by `npm run site:setup`), then a prompt.
const local = loadLocalConfig();
const url = (process.env.SITE_URL || local.SITE_URL || (await askVisible('Planner server address (https://...): '))).trim();
const token = (process.env.SITE_TOKEN || local.SITE_TOKEN || (await askHidden('Planner API token: '))).trim();
const password = process.env.SITE_PASSWORD ?? local.SITE_PASSWORD ?? (await askHidden('Site password: '));

try {
  if (password.length < 12) console.warn('\nNote: that password is short. Anyone can try guesses against the page offline; a longer one is safer.');
  console.log(`\nToken length: ${token.length} characters.`);
  // Only on this computer (never in a CI log, which can be public): lets you check the saved password has the length you expect.
  if (!process.env.CI) console.log(`Password length: ${password.length} characters.`);
  await checkServer(url, token);
  const { html } = await buildSite({ url, token, password });
  const out = join(here, '..', 'docs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`Wrote docs/index.html (${Math.round(html.length / 1024)} KB).`);
  console.log('Next: commit and push docs/, then turn on GitHub Pages (Settings > Pages > Deploy from a branch > main > /docs).');
} catch (err) {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
}
