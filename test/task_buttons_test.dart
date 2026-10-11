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
Finder get pause => find.text('PAUSE');
Finder get resume => find.text('RESUME');

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

  group('pause (pure model)', () {
    final p0 = DateTime(2026, 10, 8, 16, 40);
    Task running() => newTask(startedAt: t0);
    Task paused() => running()..pressPause(p0);

    test('which controls each phase allows', () {
      final rows = <String, (Task, List<bool>)>{
        // phase: [start, pause, resume, finish, stop]
        'idle': (newTask(), [true, false, false, false, false]),
        'running': (running(), [false, true, false, true, true]),
        'paused': (paused(), [false, false, true, true, true]),
        'done': (running()..tick(), [false, false, false, false, false]),
      };
      rows.forEach((name, row) {
        final t = row.$1;
        expect(t.phase.name, name);
        expect([t.canStart, t.canPause, t.canResume, t.canFinish, t.canStop], row.$2, reason: name);
      });
    });

    test('pause only works while running; pressing it twice keeps the first time', () {
      final idle = newTask()..pressPause(p0);
      expect(idle.pausedAt, isNull);
      final t = paused()..pressPause(p0.add(const Duration(minutes: 5)));
      expect(t.pausedAt, p0);
      final done = (running()..tick())..pressPause(p0);
      expect(done.pausedAt, isNull);
    });

    test('resume adds the time paused; several pauses add up', () {
      final t = paused()..pressResume(p0.add(const Duration(minutes: 15)));
      expect([t.phase, t.pausedAt, t.pausedMs], [TaskPhase.running, null, 15 * 60000]);
      t.pressPause(p0.add(const Duration(minutes: 20)));
      t.pressResume(p0.add(const Duration(minutes: 25)));
      expect(t.pausedMs, 20 * 60000);
      expect((running()..pressResume(p0)).pausedMs, 0); // resume without a pause: nothing
    });

    test('finishing while paused ends the pause at the finish time', () {
      final t = paused()..tick(p0.add(const Duration(minutes: 30)));
      expect([t.done, t.pausedAt, t.pausedMs], [true, null, 30 * 60000]);
    });

    test('stop and untick start the task over, pauses included', () {
      final stopped = paused()..pressStop();
      expect([stopped.phase, stopped.startedAt, stopped.pausedAt, stopped.pausedMs], [TaskPhase.idle, null, null, 0]);
      final t = (paused()..pressResume(p0.add(const Duration(minutes: 5))))..tick();
      expect(t.pausedMs, 5 * 60000);
      t.untick();
      expect([t.startedAt, t.pausedAt, t.pausedMs], [null, null, 0]);
    });

    test('an undone untick brings back the paused time too', () {
      final t = (paused()..pressResume(p0.add(const Duration(minutes: 15))))..tick(p0.add(const Duration(minutes: 30)));
      final unticks = <String, UntickUndo>{};
      final now = DateTime(2026, 10, 8, 18, 0);
      t.toggleWithUndo(unticks, now);
      expect(t.pausedMs, 0);
      t.toggleWithUndo(unticks, now.add(const Duration(seconds: 4)));
      expect([t.done, t.startedAt, t.pausedMs], [true, t0, 15 * 60000]);
    });
  });

  group('undoing an accidental untick', () {
    final started = DateTime(2026, 10, 10, 12, 56);
    final finished = DateTime(2026, 10, 10, 13, 48);
    Task finishedTask() => newTask(done: true, startedAt: started)..completedAt = finished;
    final noon = DateTime(2026, 10, 10, 14, 0);

    test('re-ticking within 10 seconds brings back the Start press and finish time', () {
      final t = finishedTask();
      final unticks = <String, UntickUndo>{};
      expect(t.toggleWithUndo(unticks, noon), isNull);
      expect(t.done, isFalse);
      expect(t.startedAt, isNull); // an untick starts the task over...
      final undo = t.toggleWithUndo(unticks, noon.add(const Duration(seconds: 9)));
      expect(undo, isNotNull); // ...unless it is undone straight away
      expect([t.done, t.startedAt, t.completedAt], [true, started, finished]);
      expect(unticks, isEmpty);
    });

    test('after 10 seconds a re-tick is an ordinary tick: no Start press, finish time is now', () {
      final t = finishedTask();
      final unticks = <String, UntickUndo>{};
      t.toggleWithUndo(unticks, noon);
      final later = noon.add(const Duration(seconds: 11));
      expect(t.toggleWithUndo(unticks, later), isNull);
      expect([t.done, t.startedAt, t.completedAt], [true, null, later]);
    });

    test('an undo is used once: untick, undo, untick, wait, tick is ordinary', () {
      final t = finishedTask();
      final unticks = <String, UntickUndo>{};
      t.toggleWithUndo(unticks, noon);
      t.toggleWithUndo(unticks, noon.add(const Duration(seconds: 2))); // undone
      t.toggleWithUndo(unticks, noon.add(const Duration(minutes: 1))); // untick again
      expect(t.toggleWithUndo(unticks, noon.add(const Duration(minutes: 2))), isNull);
      expect(t.startedAt, isNull);
    });

    test('a task ticked from idle can be unticked and undone too', () {
      final t = newTask();
      final unticks = <String, UntickUndo>{};
      t.toggleWithUndo(unticks, noon); // tick
      expect(t.completedAt, noon);
      t.toggleWithUndo(unticks, noon.add(const Duration(seconds: 3))); // untick
      final undo = t.toggleWithUndo(unticks, noon.add(const Duration(seconds: 5)));
      expect(undo, isNotNull);
      expect([t.done, t.startedAt, t.completedAt], [true, null, noon]);
    });

    test('other tasks are not affected', () {
      final a = finishedTask();
      final b = Task(id: 'other', label: 'x', tag: TaskTag.sat);
      final unticks = <String, UntickUndo>{};
      a.toggleWithUndo(unticks, noon);
      b.toggleWithUndo(unticks, noon.add(const Duration(seconds: 1)));
      expect(b.startedAt, isNull);
      expect(b.completedAt, noon.add(const Duration(seconds: 1)));
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
              onPause: () => setState(() => task.pressPause(DateTime(2026, 10, 8, 16, 40))),
              onResume: () => setState(() => task.pressResume(DateTime(2026, 10, 8, 16, 55))),
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


    testWidgets('running: PAUSE appears next to FINISH; paused: RESUME replaces it and the timer says so', (tester) async {
      final task = await mount(tester, newTask());
      expect(pause, findsNothing); // idle: nothing to pause
      await tester.tap(start);
      await tester.pump();
      expect([pause.evaluate().length, resume.evaluate().length, finish.evaluate().length], [1, 0, 1]);
      await tester.tap(pause);
      await tester.pump();
      expect(task.phase, TaskPhase.paused);
      expect([pause.evaluate().length, resume.evaluate().length, finish.evaluate().length, stop.evaluate().length], [0, 1, 1, 1]);
      expect(find.textContaining('paused '), findsOneWidget);
      await tester.tap(resume);
      await tester.pump();
      expect(task.phase, TaskPhase.running);
      expect(task.pausedMs, 15 * 60000);
      expect([pause.evaluate().length, resume.evaluate().length], [1, 0]);
      expect(task.done, isFalse); // pausing and resuming never tick the task
    });

    testWidgets('finishing a paused task works and ends the pause; no pause controls after', (tester) async {
      final task = await mount(tester, newTask(startedAt: t0));
      await tester.tap(pause);
      await tester.pump();
      await tester.tap(finish);
      await tester.pump();
      expect(task.done, isTrue);
      expect(task.pausedAt, isNull);
      expect([pause.evaluate().length, resume.evaluate().length, finish.evaluate().length, stop.evaluate().length], [0, 0, 0, 0]);
    });

    testWidgets('stop from paused: back to START with no pause left', (tester) async {
      final task = await mount(tester, newTask(startedAt: t0));
      await tester.tap(pause);
      await tester.pump();
      await tester.tap(stop);
      await tester.pump();
      expect([task.phase, task.pausedAt, task.pausedMs], [TaskPhase.idle, null, 0]);
      expect([start.evaluate().length, pause.evaluate().length, resume.evaluate().length], [1, 0, 0]);
    });

    testWidgets('unticking a task that had pauses: START again, no pause or resume', (tester) async {
      final task = await mount(tester, newTask(startedAt: t0));
      await tester.tap(pause);
      await tester.pump();
      await tester.tap(resume);
      await tester.pump();
      await tester.tap(finish);
      await tester.pump();
      await tester.tap(find.text('Calc 3 practice')); // untick
      await tester.pump();
      expect([task.done, task.startedAt, task.pausedMs], [false, null, 0]);
      expect([start.evaluate().length, pause.evaluate().length, resume.evaluate().length], [1, 0, 0]);
    });

    testWidgets('PAUSE and RESUME have big tap areas: a miss 5 px below still hits', (tester) async {
      final task = await mount(tester, newTask(startedAt: t0));
      final r = tester.getRect(pause);
      await tester.tapAt(Offset(r.center.dx, r.bottom + 5));
      await tester.pump();
      expect(task.phase, TaskPhase.paused);
      final r2 = tester.getRect(resume);
      await tester.tapAt(Offset(r2.center.dx, r2.bottom + 5));
      await tester.pump();
      expect(task.phase, TaskPhase.running);
      expect(task.done, isFalse);
    });

    testWidgets('on a narrow phone nothing runs under the stop button or off the row', (tester) async {
      // 320 px wide, the smallest phones: FINISH + RESUME + the timer text must wrap, not overlap or overflow
      final task = await mount(tester, newTask(startedAt: t0, notes: 'how'));
      await tester.binding.setSurfaceSize(const Size(320, 800));
      await tester.pump();
      await tester.tap(pause);
      await tester.pump();
      expect(task.phase, TaskPhase.paused);
      final stopRect = tester.getRect(stop);
      for (final f in [finish, resume, find.textContaining('paused ')]) {
        final r = tester.getRect(f);
        expect(r.overlaps(stopRect), isFalse, reason: 'a control overlaps the stop button');
        expect(r.right, lessThanOrEqualTo(stopRect.left + 1), reason: 'a control runs under the right-hand buttons');
      }
      expect(tester.takeException(), isNull); // no RenderFlex overflow
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
      // "+ how to start": 9 px below its text still opens the notes (it used to fall through and tick the task)
      final how = tester.getCenter(find.text('+ how to start'));
      await tester.tapAt(how + const Offset(0, 9));
      await tester.pump();
      expect(find.text('- hide how'), findsOneWidget);
      expect(task.done, isFalse);
      // START: 5 px below its box still starts it
      final r = tester.getRect(start);
      await tester.tapAt(Offset(r.center.dx, r.bottom + 5));
      await tester.pump();
      expect(task.phase, TaskPhase.running);
      // the stop and flag buttons are at least 40 px
      expect(tester.getSize(find.ancestor(of: stop, matching: find.byType(Container)).last).height, greaterThanOrEqualTo(40));
      expect(tester.getSize(find.ancestor(of: find.byIcon(Icons.flag), matching: find.byType(SizedBox)).first).height, greaterThanOrEqualTo(40));
    });
  });
}
