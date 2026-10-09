// Builds the locked page: the whole planner site is encrypted into one blob, and the page that is actually served is
// only a plain-looking search box plus that blob. Nothing about the planner (its code, its address, its token) exists
// in the served page until the exact password is typed into the search box.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptBlob } from './src/crypto.mjs';
import { encryptBlob } from './encrypt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

/** Drops `export` so a module's source can run as a plain script. Refuses anything that imports. */
function asScript(source, name) {
  if (/^\s*import\s/m.test(source)) throw new Error(`${name} must not import anything (it is inlined into the page)`);
  return source.replace(/^export\s+/gm, '');
}

/** Removes whole-line // comments, so the served page carries no explanations of how it works. */
function withoutLineComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*\/\/(?!\/)/.test(line))
    .join('\n');
}

const insert = (template, token, value) => {
  if (!template.includes(token)) throw new Error(`template is missing ${token}`);
  return template.replace(token, () => value);
};

export function validateConfig({ url, token, password }) {
  const problems = [];
  let u = null;
  try {
    u = new URL(url);
  } catch {
    problems.push('the planner server address is not a valid URL');
  }
  if (u) {
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      problems.push('the planner server address must start with https:// (http:// is only allowed for localhost)');
    }
  }
  if (!token || token.length < 16) problems.push('the planner token looks too short');
  else if (/^(.{16,}?)\1+$/.test(token)) problems.push('the planner token looks pasted more than once (it is one string repeated)');
  if (!password) problems.push('the password is empty');
  return problems;
}

/**
 * Returns the finished page (`html`) and, for tests, the unencrypted app page (`appHtml`).
 * `url` is the planner server (Worker) address and `token` its API token; both end up inside the encrypted blob only.
 */
export async function buildSite({ url, token, password }) {
  const problems = validateConfig({ url, token, password });
  if (problems.length) throw new Error(problems.join('; '));

  const logic = asScript(read('src/logic.mjs'), 'logic.mjs');
  const ui = read('src/ui.js');
  const appJs = withoutLineComments(logic) + '\n' + withoutLineComments(ui);
  if (/<\/script/i.test(appJs)) throw new Error('the app script must not contain a closing script tag');

  const cfg = JSON.stringify({ url: url.replace(/\/+$/, ''), token }).replace(/</g, '\\u003c');
  let vibes = [];
  try {
    vibes = JSON.parse(readFileSync(join(here, '..', 'assets', 'vibes.json'), 'utf8')).vibes ?? [];
  } catch {
    // the daily verse is optional
  }
  let appHtml = read('src/app.html');
  appHtml = insert(appHtml, '__CFG__', cfg);
  appHtml = insert(appHtml, '__VIBES__', JSON.stringify(vibes).replace(/</g, '\\u003c'));
  appHtml = insert(appHtml, '__APP_JS__', appJs);

  const blob = encryptBlob(password, appHtml);
  if ((await decryptBlob(password, blob)) !== appHtml) throw new Error('self-check failed: the blob does not decrypt back');
  if ((await decryptBlob(password + 'x', blob)) !== null) throw new Error('self-check failed: a wrong password decrypted');

  const unlockJs = withoutLineComments(asScript(read('src/crypto.mjs'), 'crypto.mjs'));
  let html = read('src/shell.html');
  html = insert(html, '__UNLOCK_JS__', unlockJs);
  html = insert(html, '__BLOB__', blob);
  if (html.includes(token) || html.includes(url)) throw new Error('the served page must not contain the token or the address');
  return { html, appHtml };
}
