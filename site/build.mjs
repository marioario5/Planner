// Builds the locked planner website into docs/index.html (the folder GitHub Pages serves).
//
//   node site/build.mjs          (or: cd server && npm run site:build)
//
// It asks for three things (nothing is stored; the secrets never go into git):
//   - the planner server address (your Worker, https://...workers.dev)
//   - the planner API token (the same one the phone app uses)
//   - the password that unlocks the site (typed into the search box)
// You can also provide them as SITE_URL, SITE_TOKEN and SITE_PASSWORD environment variables.
// Before writing anything it checks that the server really accepts the token.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function askVisible(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Reads a secret without showing it. Works with paste: it stops at the first Enter and ignores anything after it. */
function askHidden(question) {
  if (!process.stdin.isTTY) return askVisible(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') process.exit(130); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

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

const url = (process.env.SITE_URL || (await askVisible('Planner server address (https://...): '))).trim();
const token = (process.env.SITE_TOKEN || (await askHidden('Planner API token: '))).trim();
const password = process.env.SITE_PASSWORD ?? (await askHidden('Site password: '));

try {
  if (password.length < 12) console.warn('\nNote: that password is short. Anyone can try guesses against the page offline; a longer one is safer.');
  console.log(`\nToken length: ${token.length} characters.`);
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
