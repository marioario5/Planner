// Builds the locked planner website into docs/index.html (the folder GitHub Pages serves).
//
//   node site/build.mjs
//
// It asks for three things (nothing is stored; the secrets never go into git):
//   - the planner server address (your Worker, https://...workers.dev)
//   - the planner API token (the same one the phone app uses)
//   - the password that unlocks the site (typed into the search box)
// You can also provide them as SITE_URL, SITE_TOKEN and SITE_PASSWORD environment variables.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const url = process.env.SITE_URL || (await ask('Planner server address (https://...): ', false)).trim();
const token = process.env.SITE_TOKEN || (await ask('Planner API token: ', true)).trim();
const password = process.env.SITE_PASSWORD ?? (await ask('Site password: ', true));

try {
  if (password.length < 12) console.warn('\nNote: that password is short. Anyone can try guesses against the page offline; a longer one is safer.');
  const { html } = await buildSite({ url, token, password });
  const out = join(here, '..', 'docs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`\nWrote docs/index.html (${Math.round(html.length / 1024)} KB).`);
  console.log('Next: commit and push docs/, then turn on GitHub Pages (Settings > Pages > Deploy from a branch > main > /docs).');
} catch (err) {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
}
