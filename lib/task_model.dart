enum TaskTag { school, calculus3, sat, pcb, photography, college, other }

/// Where a task is in its life. Every button's behavior follows from this (see [Task]).
enum TaskPhase { idle, running, done }

/// The planner's day starts at 4:00am, not midnight, because he works past midnight:
/// 12:30am still belongs to the day that is ending. The server uses the same hour.
const int dayStartHour = 4;

/// The moment whose calendar date is the current planner day.
DateTime plannerDay([DateTime? now]) =>
    (now ?? DateTime.now()).subtract(const Duration(hours: dayStartHour));

/// "15:30" -> "3:30pm". Returns the input unchanged if it isn't HH:MM.
String formatClock(String hhmm) {
  final parts = hhmm.split(':');
  final h = parts.length == 2 ? int.tryParse(parts[0]) : null;
  if (h == null) return hhmm;
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:${parts[1]}${h >= 12 ? 'pm' : 'am'}';
}

/// How long after an untick a re-tick puts the old Start press and finish time back (an accidental untick).
const Duration undoUntickWindow = Duration(seconds: 10);

/// What an untick threw away, so an immediate re-tick can bring it back.
class UntickUndo {
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime unticked;
  const UntickUndo({this.startedAt, this.completedAt, required this.unticked});

  /// True while a re-tick at [now] still counts as undoing the untick.
  bool isFresh(DateTime now) => now.difference(unticked) <= undoUntickWindow;
}

class Task {
  final String id;
  String label;
  bool done;
  TaskTag tag;

  /// 'A' (the normal day) or 'B' (the backup plan).
  final String plan;

  /// 24-hour "HH:MM", or null for an untimed task.
  final String? start;
  final int? minutes;
  final String? notes;

  /// When he pressed Start on it (local time), or null.
  DateTime? startedAt;

  /// When it was checked off (local time), or null. Only needed to undo an accidental untick.
  DateTime? completedAt;

  /// He held the flag on it: his start or finish time for this task is wrong,
  /// so the planner must not learn from it.
  bool flagged;

  Task({
    required this.id,
    required this.label,
    this.done = false,
    required this.tag,
    this.plan = 'A',
    this.start,
    this.minutes,
    this.notes,
    this.startedAt,
    this.completedAt,
    this.flagged = false,
  });

  // ── What the buttons do ────────────────────────────────────────────────────
  //
  //   phase    visible controls               tap START     tap FINISH / row    tap STOP   untick
  //   idle     START                          -> running    -> done (no timer)  -         -
  //   running  FINISH + stop (under flag)     -             -> done             -> idle    -
  //   done     (just "started 4:20pm")        -             -                   -          -> idle
  //
  // - Ticking the row is the same as FINISH, and works from idle (a tick with no Start press has no
  //   real duration, only the tick time).
  // - Unticking always starts the task over: the Start press goes with it, so START shows again.
  //   Ticking it again within 10 seconds undoes that: the old Start press and finish time come back.
  // - STOP only exists while running. It forgets the Start press; it never ticks or unticks.
  // - The flag is separate: it survives every transition above.

  TaskPhase get phase =>
      done ? TaskPhase.done : (startedAt != null ? TaskPhase.running : TaskPhase.idle);

  bool get canStart => phase == TaskPhase.idle;
  bool get canFinish => phase == TaskPhase.running;
  bool get canStop => phase == TaskPhase.running;

  /// START: only from idle. Pressing it again while running keeps the first press.
  void pressStart(DateTime now) {
    if (phase == TaskPhase.idle) startedAt = now;
  }

  /// STOP: only while running; forgets the Start press.
  void pressStop() {
    if (phase == TaskPhase.running) startedAt = null;
  }

  /// FINISH, or ticking the row. Keeps the Start press so the server can work out the real duration.
  void tick([DateTime? now]) {
    done = true;
    completedAt = now ?? DateTime.now();
  }

  /// Unticking starts the task over.
  void untick() {
    done = false;
    startedAt = null;
    completedAt = null;
  }

  /// What an untick right now would throw away.
  UntickUndo undoOfUntick([DateTime? now]) =>
      UntickUndo(startedAt: startedAt, completedAt: completedAt, unticked: now ?? DateTime.now());

  /// Re-ticking within [undoUntickWindow] of an untick: done again with the original Start press and finish time.
  void restore(UntickUndo undo) {
    done = true;
    startedAt = undo.startedAt;
    completedAt = undo.completedAt ?? DateTime.now();
  }

  /// A tap on the row's checkbox/label.
  void toggleDone() => done ? untick() : tick();

  /// A tap on the checkbox/row/FINISH that remembers what an untick throws away in [unticks]. Ticking again within
  /// [undoUntickWindow] of an untick puts the old Start press and finish time back; returns that snapshot so the
  /// server can restore it too, or null for an ordinary tick or untick.
  UntickUndo? toggleWithUndo(Map<String, UntickUndo> unticks, [DateTime? now]) {
    final at = now ?? DateTime.now();
    if (done) {
      unticks[id] = undoOfUntick(at);
      untick();
      return null;
    }
    final undo = unticks.remove(id);
    if (undo != null && undo.isFresh(at)) {
      restore(undo);
      return undo;
    }
    tick(at);
    return null;
  }

  /// "4:20pm" for when he pressed Start; null if he hasn't.
  String? get startedLabel {
    final t = startedAt;
    if (t == null) return null;
    return formatClock('${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}');
  }

  /// e.g. "3:30pm · 25m"; null when the task has no time.
  String? get timeLabel {
    final s = start;
    if (s == null) return null;
    final time = formatClock(s);
    return minutes == null ? time : '$time · ${minutes}m';
  }
}

/// A titled block of text Claude writes for the day. Each one is a button.
class InfoSection {
  final String title;
  final String body;
  const InfoSection({required this.title, required this.body});
}

class DayPlan {
  /// Every plan's tasks for the day (Plan A and, if there is one, Plan B).
  final List<Task> tasks;
  final String? headline;
  final List<InfoSection> sections;

  /// How the day felt, 1 (rough) to 5 (great), or null.
  final int? rating;
  const DayPlan({required this.tasks, this.headline, this.sections = const [], this.rating});
}

/// Short text shown on the receipt. (`name` is the enum's built-in id, which
/// is also what the server uses.)
extension TaskTagLabel on TaskTag {
  String get label {
    switch (this) {
      case TaskTag.school:      return 'school';
      case TaskTag.calculus3:   return 'calc 3';
      case TaskTag.sat:         return 'sat';
      case TaskTag.pcb:         return 'pcb';
      case TaskTag.photography: return 'photo';
      case TaskTag.college:     return 'college';
      case TaskTag.other:       return 'other';
    }
  }
}
