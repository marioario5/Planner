enum TaskTag { korean, calculus, trombone, projects, other}

class Task {
  final String id;
  final String listId;
  String label;
  bool done;
  TaskTag tag;

  Task({
    required this.id,
    required this.listId,
    required this.label,
    this.done = false,
    required this.tag,
  });
}

extension TaskTagLabel on TaskTag {
  String get name {
    switch (this) {
      case TaskTag.korean: return 'korean';
      case TaskTag.calculus: return 'calculus';
      case TaskTag.trombone:   return 'trombone';
      case TaskTag.projects:   return 'projects';
      case TaskTag.other:      return 'other';
    }
  }
}
