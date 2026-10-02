enum TaskTag { school, calculus3, sat, pcb, photography }

class Task {
  final String id;
  String label;
  bool done;
  TaskTag tag;

  Task({
    required this.id,
    required this.label,
    this.done = false,
    required this.tag,
  });
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
