// The gym switch: it records on the phone first, and sends later if there is no connection.

import 'package:cozy_planner/gym_tracker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late List<String> sent;
  late bool online;
  late DateTime now;

  GymTracker make() => GymTracker(
        send: (id, started, ended, mode) async {
          if (!online) return false;
          sent.add('$id ${started.hour}:${started.minute} ${ended == null ? 'open' : '${ended.hour}:${ended.minute}'}');
          return true;
        },
        clock: () => now,
      );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    sent = [];
    online = true;
    now = DateTime.utc(2026, 10, 11, 18, 0);
  });

  test('online: start and stop are each sent at once', () async {
    final g = make();
    await g.toggle();
    expect(g.atGym, isTrue);
    expect(sent, hasLength(1));
    expect(g.unsynced, 0);

    now = now.add(const Duration(minutes: 70));
    await g.toggle();
    expect(g.atGym, isFalse);
    expect(sent.last, endsWith('19:10'));
    expect(g.unsynced, 0);
  });

  test('offline: both times are kept and sent, with the real times, when the connection returns', () async {
    online = false;
    final g = make();
    await g.toggle();
    now = now.add(const Duration(minutes: 45));
    await g.toggle(); // all of it with no signal
    expect(g.atGym, isFalse);
    expect(g.unsynced, 1);
    expect(sent, isEmpty);

    online = true;
    now = now.add(const Duration(hours: 5)); // sent much later; the times must still be the real ones
    await g.flush();
    expect(sent, hasLength(1));
    expect(sent.single, endsWith('18:45'));
    expect(g.unsynced, 0);
  });

  test('survives closing the app while offline, including a session still in progress', () async {
    online = false;
    final first = make();
    await first.toggle();

    final reopened = make();
    await reopened.load();
    expect(reopened.atGym, isTrue);
    expect(reopened.since, now);
    expect(reopened.unsynced, 1);

    now = now.add(const Duration(minutes: 30));
    await reopened.toggle();
    online = true;
    await reopened.flush();
    expect(sent, hasLength(1));
    expect(sent.single, endsWith('18:30'));
  });

  test('a failed send never throws and is retried', () async {
    final g = GymTracker(send: (id, s, e, m) async => throw Exception('no route'), clock: () => now);
    await g.toggle();
    expect(g.unsynced, 1);
    await g.flush();
    expect(g.unsynced, 1);
  });

  test('stopping while the start is still being sent keeps the stop for another send', () async {
    late GymTracker g;
    var calls = 0;
    g = GymTracker(
      send: (id, s, e, m) async {
        calls++;
        if (calls == 1) {
          now = now.add(const Duration(minutes: 20));
          await g.toggle(); // he stops while the first send is in flight
        }
        return true;
      },
      clock: () => now,
    );
    await g.toggle();
    expect(g.atGym, isFalse);
    expect(g.unsynced, 1); // the stop is not lost
    await g.flush();
    expect(g.unsynced, 0);
  });
}
