enum TaskTag { cozy, nature, work, home, social, wild, gold }

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
      case TaskTag.cozy:   return 'cozy';
      case TaskTag.nature: return 'nature';
      case TaskTag.work:   return 'work';
      case TaskTag.home:   return 'home';
      case TaskTag.social: return 'social';
      case TaskTag.wild:   return 'wild';
      case TaskTag.gold:   return 'gold';
    }
  }
}
