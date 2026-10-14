// The daily verse must match the website's (server/test/verse.test.mjs checks the same answers).
import 'package:cozy_planner/verse.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  test('the same pick as the website for each day', () {
    expect(verseFor(DateTime(2026, 10, 13), list), 'g');
    expect(verseFor(DateTime(2026, 10, 14), list), 'a');
    expect(verseFor(DateTime(2027, 1, 1), list), 'g');
  });

  test('falls back when the list is empty', () {
    expect(verseFor(DateTime(2026, 10, 13), []), 'Matthew 11:29');
  });
}
