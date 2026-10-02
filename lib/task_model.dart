enum TaskTag { school, calculus3, sat, pcb, photography }

class Task {
  final String id;
  String label;
  bool done;
  TaskTag tag;

  /// 24-hour "HH:MM", or null for an untimed task.
  final String? start;
  final int? minutes;
  final String? notes;

  Task({
    required this.id,
    required this.label,
    this.done = false,
    required this.tag,
    this.start,
    this.minutes,
    this.notes,
  });

  /// e.g. "3:30pm · 25m"; null when the task has no time.
  String? get timeLabel {
    final s = start;
    if (s == null) return null;
    final parts = s.split(':');
    final h = parts.length == 2 ? int.tryParse(parts[0]) : null;
    if (h == null) return s;
    final h12 = h % 12 == 0 ? 12 : h % 12;
    final time = '$h12:${parts[1]}${h >= 12 ? 'pm' : 'am'}';
    return minutes == null ? time : '$time · ${minutes}m';
  }
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
