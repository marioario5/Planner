// Rebuilds the locked website and publishes it in one go:  node site/publish.mjs   (or: cd server && npm run site:publish)
//
// It runs the build (site/build.mjs), then commits ONLY docs/ and pushes. Nothing else is touched.
// Set SITE_URL and SITE_TOKEN once (see site/README.md) and the only thing left to type is the site password.
// The password is never written anywhere; set SITE_PASSWORD only for a single run if you want no prompt at all.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
}

const build = run(process.execPath, [join(here, 'build.mjs')]);
if (build.status !== 0) {
  console.error('\nThe build did not finish, so nothing was committed or pushed.');
  process.exit(build.status ?? 1);
}

run('git', ['add', '--', 'docs']);
const unchanged = spawnSync('git', ['diff', '--cached', '--quiet', '--', 'docs'], { cwd: root }).status === 0;
if (unchanged) {
  console.log('\nThe built page is identical to the published one: nothing to commit.');
  process.exit(0);
}
if (run('git', ['commit', '-m', 'Rebuild website', '--', 'docs']).status !== 0) process.exit(1);
if (run('git', ['push']).status !== 0) {
  console.error('\nCommitted, but the push failed. Run "git push" when you are online.');
  process.exit(1);
}
console.log('\nPublished. GitHub Pages usually takes a minute or two to show it.');
