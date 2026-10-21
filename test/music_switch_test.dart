// The printer's button (YouTube mode): pink = nothing, blue = browsing, green = lecture. A second recorder next to the gym switch,
// offline first, never mixed with it.

import 'dart:ui' show PictureRecorder;

import 'package:cozy_planner/gym_tracker.dart';
import 'package:cozy_planner/printer_painter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const order = ['browsing', 'lecture'];

void main() {
  late DateTime now;
  late List<String> gymSent;
  late List<String> musicSent;
  late bool online;

  GymTracker gym() => GymTracker(
        send: (id, s, e, m) async {
          if (!online) return false;
          gymSent.add(id);
          return true;
        },
        clock: () => now,
      );
  GymTracker music() => GymTracker(
        name: 'music',
        send: (id, s, e, m) async {
          if (!online) return false;
          musicSent.add('$id $m ${e == null ? 'open' : 'closed'}');
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

  test('one tap at a time steps off -> browsing -> lecture -> off', () async {
    final m = music();
    expect(m.mode, isNull);
    await m.advance(order);
    expect(m.mode, 'browsing');
    now = now.add(const Duration(minutes: 20));
    await m.advance(order);
    expect(m.mode, 'lecture');
    now = now.add(const Duration(minutes: 40));
    await m.advance(order);
    expect(m.mode, isNull);
    expect(m.atGym, isFalse);
  });

  test('moving between modes ends one session and starts the next at the same instant, with their own ids', () async {
    final m = music();
    await m.advance(order); // browsing starts
    now = now.add(const Duration(minutes: 20));
    await m.advance(order); // browsing ends, lecture starts, same moment
    now = now.add(const Duration(minutes: 40));
    await m.advance(order); // lecture ends
    final closed = musicSent.where((s) => s.endsWith('closed')).toList();
    expect(closed.map((s) => s.split(' ')[1]), ['browsing', 'lecture']);
    final ids = musicSent.map((s) => s.split(' ')[0]).toSet();
    expect(ids.length, 2); // the browsing session and the lecture session each have their own id
    expect(musicSent.every((s) => s.startsWith('m')), isTrue);
    expect(m.unsynced, 0);
  });

  test('offline: every stretch and its mode is kept, and sent later; a lecture left on survives closing the app', () async {
    online = false;
    final first = music();
    await first.advance(order);
    now = now.add(const Duration(minutes: 10));
    await first.advance(order); // lecture, left on
    final reopened = music();
    await reopened.load();
    expect(reopened.mode, 'lecture');
    expect(reopened.unsynced, 2);
    online = true;
    await reopened.flush();
    expect(musicSent.where((s) => s.contains(' browsing ')), hasLength(1));
    expect(musicSent.where((s) => s.contains(' lecture ')), hasLength(1));
    expect(reopened.unsynced, 0);
  });

  test('the gym switch and YouTube mode never share state', () async {
    final g = gym();
    final m = music();
    await g.toggle();
    expect(g.atGym, isTrue);
    expect(m.atGym, isFalse);
    await m.advance(order);
    final gymAgain = gym();
    await gymAgain.load();
    final musicAgain = music();
    await musicAgain.load();
    expect([gymAgain.atGym, musicAgain.mode], [true, 'browsing']);
    await g.toggle();
    final gymOff = gym();
    await gymOff.load();
    final musicStill = music();
    await musicStill.load();
    expect([gymOff.atGym, musicStill.mode], [false, 'browsing']); // stopping the gym left YouTube mode on
    expect(gymSent.every((id) => id.startsWith('g')), isTrue);
  });

  test('the button is hit on the button and a little around it, not on the rest of the printer', () {
    expect(hitsPinkButton(printerPinkButton.center), isTrue);
    expect(hitsPinkButton(printerPinkButton.topLeft - const Offset(8, 8)), isTrue); // a near miss still counts
    expect(hitsPinkButton(const Offset(160, 60)), isFalse); // the paper slot area
    expect(hitsPinkButton(const Offset(300, 20)), isFalse); // the lights
  });

  test('the printer draws all three states without error', () {
    for (final mode in [null, 'browsing', 'lecture']) {
      final recorder = PictureRecorder();
      PrinterPainter(blinkPhase: 0.3, musicMode: mode).paint(Canvas(recorder), const Size(320, 108));
      recorder.endRecording();
    }
  });
}
