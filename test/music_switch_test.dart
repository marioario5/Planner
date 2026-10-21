// The printer's pink button (YouTube mode): a second recorder next to the gym switch, offline first, never mixed with it.

import 'dart:ui' show PictureRecorder;

import 'package:cozy_planner/gym_tracker.dart';
import 'package:cozy_planner/printer_painter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late DateTime now;
  late List<String> gymSent;
  late List<String> musicSent;
  late bool online;

  GymTracker gym() => GymTracker(
        send: (id, s, e) async {
          if (!online) return false;
          gymSent.add(id);
          return true;
        },
        clock: () => now,
      );
  GymTracker music() => GymTracker(
        name: 'music',
        send: (id, s, e) async {
          if (!online) return false;
          musicSent.add('$id ${e == null ? 'open' : 'closed'}');
          return true;
        },
        clock: () => now,
      );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    gymSent = [];
    musicSent = [];
    online = true;
    now = DateTime.utc(2026, 10, 20, 22, 0);
  });

  test('YouTube mode records start and stop, with an id that starts with m', () async {
    final m = music();
    await m.toggle();
    expect(m.atGym, isTrue); // "on"
    expect(musicSent.single, startsWith('m'));
    now = now.add(const Duration(minutes: 40));
    await m.toggle();
    expect(m.atGym, isFalse);
    expect(musicSent.last, endsWith('closed'));
    expect(m.unsynced, 0);
  });

  test('offline: kept and sent later, and it survives closing the app while on', () async {
    online = false;
    final first = music();
    await first.toggle();
    final reopened = music();
    await reopened.load();
    expect(reopened.atGym, isTrue);
    expect(reopened.unsynced, 1);
    online = true;
    await reopened.flush();
    expect(musicSent, hasLength(1));
    expect(reopened.unsynced, 0);
  });

  test('the gym switch and YouTube mode never share state', () async {
    final g = gym();
    final m = music();
    await g.toggle();
    expect(g.atGym, isTrue);
    expect(m.atGym, isFalse);
    await m.toggle();
    final gymAgain = gym();
    await gymAgain.load();
    final musicAgain = music();
    await musicAgain.load();
    expect([gymAgain.atGym, musicAgain.atGym], [true, true]);
    await g.toggle();
    final gymOff = gym();
    await gymOff.load();
    final musicStill = music();
    await musicStill.load();
    expect([gymOff.atGym, musicStill.atGym], [false, true]); // stopping the gym left YouTube mode on
    expect(gymSent.every((id) => id.startsWith('g')), isTrue);
    expect(musicSent.every((id) => id.startsWith('m')), isTrue);
  });

  test('the pink button is hit on the button and a little around it, not on the rest of the printer', () {
    expect(hitsPinkButton(printerPinkButton.center), isTrue);
    expect(hitsPinkButton(printerPinkButton.topLeft - const Offset(8, 8)), isTrue); // a near miss still counts
    expect(hitsPinkButton(const Offset(160, 60)), isFalse); // the paper slot area
    expect(hitsPinkButton(const Offset(300, 20)), isFalse); // the lights
  });

  test('the printer draws both states without error', () {
    for (final on in [false, true]) {
      final recorder = PictureRecorder();
      PrinterPainter(blinkPhase: 0.3, youtubeOn: on).paint(Canvas(recorder), const Size(320, 108));
      recorder.endRecording();
    }
  });
}
