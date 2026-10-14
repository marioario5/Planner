// The daily verse must be the same on the website and the phone app (test/verse_test.dart checks the same answers).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { verseFor } from '../../site/src/logic.mjs';

const LIST = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

describe('daily verse', () => {
  it('is a fixed pick for each day, identical to the phone app', () => {
    expect(verseFor('2026-10-13', LIST)).toBe('g');
    expect(verseFor('2026-10-14', LIST)).toBe('a');
    expect(verseFor('2027-01-01', LIST)).toBe('g');
  });
  it('does not change within a day and falls back when the list is empty', () => {
    expect(verseFor('2026-10-13', LIST)).toBe(verseFor('2026-10-13', LIST));
    expect(verseFor('2026-10-13', [])).toBe('Matthew 11:29');
  });
  it('the shared list has no duplicates and includes verses about Christ with us in suffering', () => {
    const { verses } = JSON.parse(readFileSync(new URL('../../assets/verses.json', import.meta.url), 'utf8'));
    expect(new Set(verses).size).toBe(verses.length);
    for (const v of ['Hebrews 4:15-16', 'Isaiah 53:3-5', 'Psalm 23:4', '2 Corinthians 1:3-5', 'Matthew 28:20']) expect(verses).toContain(v);
  });
});
