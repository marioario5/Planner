// The private settings file for building the website (.site-local.env): parsing, writing, and that git ignores it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLocalConfig, loadLocalConfig, parseLocalConfig } from '../../site/localconfig.mjs';

describe('the local settings file', () => {
  it('reads KEY=value lines, skips comments and blanks and unknown keys, keeps the password exactly', () => {
    const text = '# comment\n\nSITE_URL=https://a.workers.dev\r\nSITE_TOKEN=tok=en\nSITE_PASSWORD= a b=c \nOTHER=x\nnonsense\n';
    expect(parseLocalConfig(text)).toEqual({ SITE_URL: 'https://a.workers.dev', SITE_TOKEN: 'tok=en', SITE_PASSWORD: ' a b=c ' });
  });

  it('writes what it reads, leaving out empty values', () => {
    const text = formatLocalConfig({ SITE_URL: 'https://a.workers.dev', SITE_TOKEN: 'secret-token-value', SITE_PASSWORD: '' });
    expect(text).toContain('SITE_URL=https://a.workers.dev');
    expect(text).not.toContain('SITE_PASSWORD');
    expect(parseLocalConfig(text)).toEqual({ SITE_URL: 'https://a.workers.dev', SITE_TOKEN: 'secret-token-value' });
  });

  it('a missing or unreadable file is just empty', () => {
    expect(loadLocalConfig(join(mkdtempSync(join(tmpdir(), 'cfg-')), 'nope.env'))).toEqual({});
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'x.env'), 'SITE_URL=https://x\n');
    expect(loadLocalConfig(join(dir, 'x.env'))).toEqual({ SITE_URL: 'https://x' });
  });

  it('git ignores the file, so it cannot be committed by accident', () => {
    const out = execFileSync('git', ['check-ignore', '-v', '.site-local.env'], { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8' });
    expect(out).toContain('.site-local.env');
  });
});
