enum TaskTag { school, calculus3, sat, pcb, photography }

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

  Task({
    required this.id,
    required this.label,
    this.done = false,
    required this.tag,
    this.plan = 'A',
    this.start,
    this.minutes,
    this.notes,
  });

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
  const DayPlan({required this.tasks, this.headline, this.sections = const []});
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
    }
  }
}
