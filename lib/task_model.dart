enum TaskTag { basketball, calculus, work, home, social, rocket, gold }

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
      case TaskTag.basketball: return 'basketball';
      case TaskTag.calculus: return 'calculus';
      case TaskTag.work:   return 'work';
      case TaskTag.home:   return 'home';
      case TaskTag.social: return 'social';
      case TaskTag.rocket:   return 'rocket';
      case TaskTag.gold:   return 'gold';
    }
  }
}
