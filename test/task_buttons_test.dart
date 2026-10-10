// The Start / Finish / Stop / untick rules, written down as tests so they can't quietly break again.
// The table in lib/task_model.dart is the spec; each test below is one row or edge of it.

import 'package:cozy_planner/planner_screen.dart';
import 'package:cozy_planner/task_model.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

Task newTask({bool done = false, DateTime? startedAt, bool flagged = false, String? notes}) => Task(
      id: 't1',
      label: 'Calc 3 practice',
      tag: TaskTag.calculus3,
      start: '16:00',
      minutes: 40,
      done: done,
      startedAt: startedAt,
      flagged: flagged,
      notes: notes,
    );

final t0 = DateTime(2026, 10, 8, 16, 20);

Finder get start => find.text('START');
Finder get finish => find.text('FINISH');
Finder get stop => find.byIcon(Icons.stop);

void main() {
  group('task phases (pure model)', () {
    test('idle -> running -> done, and which controls each phase allows', () {
      final t = newTask();
      expect(t.phase, TaskPhase.idle);
      expect([t.canStart, t.canFinish, t.canStop], [true, false, false]);

      t.pressStart(t0);
      expect(t.phase, TaskPhase.running);
      expect([t.canStart, t.canFinish, t.canStop], [false, true, true]);

      t.tick();
      expect(t.phase, TaskPhase.done);
      expect([t.canStart, t.canFinish, t.canStop], [false, false, false]);
      expect(t.startedAt, t0, reason: 'finishing keeps the Start press so the real duration can be worked out');
    });

    test('Start pressed again while running keeps the first press', () {
      final t = newTask()..pressStart(t0);
      t.pressStart(t0.add(const Duration(minutes: 30)));
      expect(t.startedAt, t0);
    });

    test('Start does nothing on a finished task', () {
      final t = newTask(done: true);
      t.pressStart(t0);
      expect(t.startedAt, isNull);
      expect(t.phase, TaskPhase.done);
    });

    test('a tick without ever pressing Start is allowed and has no timer', () {
      final t = newTask();
      t.toggleDone();
      expect(t.phase, TaskPhase.done);
      expect(t.startedAt, isNull);
    });

    test('Stop forgets the Start press and returns to idle; it never ticks the task', () {
      final t = newTask()..pressStart(t0);
      t.pressStop();
      expect(t.phase, TaskPhase.idle);
      expect(t.startedAt, isNull);
      expect(t.done, isFalse);
    });

    test('Stop does nothing unless the task is running (idle or done)', () {
      final idle = newTask()..pressStop();
      expect(idle.phase, TaskPhase.idle);

      final finished = newTask(done: true, startedAt: t0)..pressStop();
      expect(finished.startedAt, t0, reason: 'a finished task keeps its start; there is no stop button for it');
      expect(finished.done, isTrue);
    });

    test('unticking starts the task over: Start press gone, START available, no stop button', () {
      final t = newTask(startedAt: t0)..tick();
      t.toggleDone(); // untick
      expect(t.done, isFalse);
      expect(t.startedAt, isNull);
      expect(t.phase, TaskPhase.idle);
      expect([t.canStart, t.canStop], [true, false]);
    });

    test('the flag survives every transition', () {
      final t = newTask(flagged: true);
      t.pressStart(t0);
      t.tick();
      t.untick();
      t.pressStart(t0);
      t.pressStop();
      expect(t.flagged, isTrue);
    });

    test('a full second round after unticking records a fresh start', () {
      final t = newTask()..pressStart(t0)..tick()..untick();
      final later = t0.add(const Duration(hours: 2));
      t.pressStart(later);
      expect(t.startedAt, later);
    });
  });

  group('task row (what is on screen)', () {
    setUpAll(() {
      // No network in tests: fall back to the default font instead of fetching Press Start 2P.
      GoogleFonts.config.allowRuntimeFetching = false;
    });

    // Fonts can't load in tests; that is not what is being tested.
    void ignoreFontErrors() {
      final original = FlutterError.onError;
      FlutterError.onError = (details) {
        if (details.exceptionAsString().contains('google_fonts') ||
            details.exceptionAsString().toLowerCase().contains('font')) {
          return;
        }
        original?.call(details);
      };
      addTearDown(() => FlutterError.onError = original);
    }

    /// Mounts one row and wires its callbacks to the model the same way the screen does.
    Future<Task> mount(WidgetTester tester, Task task) async {
      ignoreFontErrors();
      await tester.binding.setSurfaceSize(const Size(420, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => TaskRow(
              task: task,
              onToggle: () => setState(task.toggleDone),
              onStart: () => setState(() => task.pressStart(DateTime(2026, 10, 8, 16, 20))),
              onResetStart: () => setState(task.pressStop),
              onFlag: () => setState(() => task.flagged = !task.flagged),
              onDelete: () {},
            ),
          ),
        ),
      ));
      await tester.pump();
      return task;
    }

    testWidgets('idle: only START', (tester) async {
      await mount(tester, newTask());
      expect(start, findsOneWidget);
      expect(finish, findsNothing);
      expect(stop, findsNothing);
    });

    testWidgets('START -> running: FINISH and the stop button appear', (tester) async {
      await mount(tester, newTask());
      await tester.tap(start);
      await tester.pump();
      expect(start, findsNothing);
      expect(finish, findsOneWidget);
      expect(stop, findsOneWidget);
    });

    testWidgets('FINISH -> done: no START, no FINISH, no stop button', (tester) async {
      await mount(tester, newTask());
      await tester.tap(start);
      await tester.pump();
      await tester.tap(finish);
      await tester.pump();
      expect(start, findsNothing);
      expect(finish, findsNothing);
      expect(stop, findsNothing);
      expect(find.textContaining('started'), findsOneWidget, reason: 'the start time is kept and shown');
    });

    testWidgets('unticking a finished task: START again, and NO stop button', (tester) async {
      await mount(tester, newTask());
      await tester.tap(start);
      await tester.pump();
      await tester.tap(finish);
      await tester.pump();

      await tester.tap(find.text('Calc 3 practice')); // tap the row to untick
      await tester.pump();
      expect(start, findsOneWidget);
      expect(finish, findsNothing);
      expect(stop, findsNothing);
    });

    testWidgets('stop while running: back to START, the task is not ticked', (tester) async {
      final task = await mount(tester, newTask());
      await tester.tap(start);
      await tester.pump();
      await tester.tap(stop);
      await tester.pump();
      expect(start, findsOneWidget);
      expect(finish, findsNothing);
      expect(stop, findsNothing);
      expect(task.done, isFalse);
    });

    testWidgets('ticking the row without Start: done, no stop button, no START', (tester) async {
      final task = await mount(tester, newTask());
      await tester.tap(find.text('Calc 3 practice'));
      await tester.pump();
      expect(task.done, isTrue);
      expect(start, findsNothing);
      expect(stop, findsNothing);
    });

    testWidgets('a quick tap on the flag does nothing (it must be held 2 seconds)', (tester) async {
      final task = await mount(tester, newTask());
      await tester.tap(find.byIcon(Icons.flag));
      await tester.pump();
      expect(task.flagged, isFalse);
    });

    testWidgets('holding the flag for 2 seconds flags it; holding again clears it', (tester) async {
      final task = await mount(tester, newTask());
      Future<void> hold(Duration d) async {
        final g = await tester.startGesture(tester.getCenter(find.byIcon(Icons.flag)));
        // Flutter reports a press after ~100ms, and the hold animation starts counting on the next frame.
        await tester.pump(const Duration(milliseconds: 150));
        await tester.pump();
        await tester.pump(d);
        await g.up();
        await tester.pump();
      }

      await hold(const Duration(milliseconds: 1000)); // let go too early: nothing
      expect(task.flagged, isFalse);

      await hold(const Duration(milliseconds: 2100));
      expect(task.flagged, isTrue);

      await hold(const Duration(milliseconds: 2100));
      expect(task.flagged, isFalse);
    });

    testWidgets('the flag does not block START, and survives start/finish/untick', (tester) async {
      final task = await mount(tester, newTask(flagged: true));
      await tester.tap(start);
      await tester.pump();
      await tester.tap(finish);
      await tester.pump();
      await tester.tap(find.text('Calc 3 practice'));
      await tester.pump();
      expect(task.flagged, isTrue);
      expect(start, findsOneWidget);
    });

    testWidgets('hit areas are big: a near miss on the buttons still hits them, and never ticks the row', (tester) async {
      final task = await mount(tester, newTask(notes: 'how'));
      // "+ how to start": 12 px below its text still opens the notes (it used to fall through and tick the task)
      final how = tester.getCenter(find.text('+ how to start'));
      await tester.tapAt(how + const Offset(0, 12));
      await tester.pump();
      expect(find.text('- hide how'), findsOneWidget);
      expect(task.done, isFalse);
      // START: 10 px above and below its box still starts it
      final r = tester.getRect(start);
      await tester.tapAt(Offset(r.center.dx, r.bottom + 10));
      await tester.pump();
      expect(task.phase, TaskPhase.running);
      // the stop and flag buttons are at least 40 px
      expect(tester.getSize(find.ancestor(of: stop, matching: find.byType(Container)).last).height, greaterThanOrEqualTo(40));
      expect(tester.getSize(find.ancestor(of: find.byIcon(Icons.flag), matching: find.byType(SizedBox)).first).height, greaterThanOrEqualTo(40));
    });
  });
}
