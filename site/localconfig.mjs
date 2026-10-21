// The private settings file for building the website on this computer: <repo>/.site-local.env
// It holds lines like SITE_URL=..., SITE_TOKEN=..., SITE_PASSWORD=... and is never committed (the repo ignores every file it does not list).
// Real environment variables win over the file; anything missing from both is asked for at the prompt.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const LOCAL_CONFIG_PATH = join(here, '..', '.site-local.env');
export const LOCAL_KEYS = ['SITE_URL', 'SITE_TOKEN', 'SITE_PASSWORD'];

/** KEY=value lines; blank lines and # comments are skipped; the value is everything after the first "=" (no trimming of the password). */
export function parseLocalConfig(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const i = raw.indexOf('=');
    if (i <= 0) continue;
    const key = raw.slice(0, i).trim();
    if (LOCAL_KEYS.includes(key)) out[key] = raw.slice(i + 1);
  }
  return out;
}

export function loadLocalConfig(path = LOCAL_CONFIG_PATH) {
  try {
    return existsSync(path) ? parseLocalConfig(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function formatLocalConfig(values) {
  const lines = ['# Private settings for building the website on this computer. Never committed. Edit by hand or run: npm run site:setup'];
  for (const key of LOCAL_KEYS) if (values[key] !== undefined && values[key] !== '') lines.push(`${key}=${values[key]}`);
  return lines.join('\n') + '\n';
}
