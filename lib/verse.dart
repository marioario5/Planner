/// Today's verse: the same one on the phone app and the website, because both pick from the same list
/// (assets/verses.json) with the same rule from the same day. site/src/logic.mjs `verseFor` is the identical rule;
/// keep them in step (test/verse_test.dart and server/test/site.test.mjs check the same answers).
String verseFor(DateTime day, List<String> list) {
  if (list.isEmpty) return 'Matthew 11:29';
  final m = day.month.toString().padLeft(2, '0');
  final d = day.day.toString().padLeft(2, '0');
  final key = '${day.year}-$m-$d';
  var h = 0x811c9dc5; // FNV-1a over the date's characters
  for (final c in key.codeUnits) {
    h ^= c;
    h = (h * 16777619) & 0xFFFFFFFF;
  }
  return list[h % list.length];
}
