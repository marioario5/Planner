import 'package:google_sign_in/google_sign_in.dart';
import 'package:googleapis/tasks/v1.dart' as gtasks;
import 'package:http/http.dart' as http;
import 'task_model.dart';

class _AuthClient extends http.BaseClient {
  final Map<String, String> _headers;
  final http.Client _inner = http.Client();
  _AuthClient(this._headers);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    request.headers.addAll(_headers);
    return _inner.send(request);
  }
}

class TasksService {
  // Web client ID used as serverClientId so the token works with the
  // Tasks REST API. The Android client (registered via SHA-1 + package
  // name in Google Cloud) handles the on-device sign-in flow automatically.
  static const _webClientId =
      '1036343782202-ncvphkc4aimo4u9vphar72vl14ggrgtm.apps.googleusercontent.com';

  static final GoogleSignIn _googleSignIn = GoogleSignIn(
    serverClientId: _webClientId,
    scopes: [
      'email',
      'https://www.googleapis.com/auth/tasks',
    ],
  );

  static GoogleSignInAccount? currentUser;

  static Future<bool> signIn() async {
    try {
      GoogleSignInAccount? account = await _googleSignIn.signInSilently();
      account ??= await _googleSignIn.signIn();
      currentUser = account;
      return account != null;
    } catch (e) {
      print('Sign in error: $e');
      return false;
    }
  }

  static Future<void> signOut() async {
    await _googleSignIn.signOut();
    currentUser = null;
  }

  static bool get isSignedIn => currentUser != null;

  /// Fetch incomplete tasks from all of the user's Google Tasks lists.
  static Future<List<Task>> fetchTasks() async {
    if (currentUser == null) return [];

    try {
      final auth = await currentUser!.authentication;
      final accessToken = auth.accessToken;
      if (accessToken == null) return [];

      final client = _AuthClient({
        'Authorization': 'Bearer $accessToken',
        'X-Goog-AuthUser': '0',
      });

      final api = gtasks.TasksApi(client);

      final lists = await api.tasklists.list();
      final result = <Task>[];

      for (final list in lists.items ?? []) {
        if (list.id == null) continue;
        final tasks = await api.tasks.list(
          list.id!,
          showCompleted: false,
          showHidden: false,
        );

        for (final t in tasks.items ?? []) {
          if (t.title == null || t.title!.trim().isEmpty) continue;
          if (t.status == 'completed') continue;

          // Filter by due date — only show tasks due today or earlier
          // Tasks with no due date always show
          if (t.due != null) {
            final due = DateTime.tryParse(t.due!);
            if (due != null) {
              final today = DateTime.now();
              final todayDate = DateTime(today.year, today.month, today.day);
              final dueDate = DateTime(due.year, due.month, due.day);
              if (dueDate.isAfter(todayDate)) continue; // skip future tasks
            }
          }

          result.add(Task(
            id: t.id ?? DateTime.now().millisecondsSinceEpoch.toString(),
            listId: list.id!,
            label: t.title!,
            tag: _tagFromTitle(t.title!),
          ));
        }
      }
      return result;
    } catch (e) {
      print('Tasks fetch error: $e');
      return [];
    }
  }

  /// Marks a task as completed (or not) directly in Google Tasks.
  /// This is the same store Google Calendar's task list reads from,
  /// so checking a task off here also checks it off in Calendar.
  static Future<bool> setTaskCompleted(Task task, bool completed) async {
    if (currentUser == null) return false;

    try {
      final auth = await currentUser!.authentication;
      final accessToken = auth.accessToken;
      if (accessToken == null) return false;

      final client = _AuthClient({
        'Authorization': 'Bearer $accessToken',
        'X-Goog-AuthUser': '0',
      });

      final api = gtasks.TasksApi(client);

      final patch = gtasks.Task(
        status: completed ? 'completed' : 'needsAction',
      );
      if (completed) {
        patch.completed = DateTime.now().toUtc().toIso8601String();
      }

      await api.tasks.patch(patch, task.listId, task.id);
      return true;
    } catch (e) {
      print('Task update error: $e');
      return false;
    }
  }

  static TaskTag _tagFromTitle(String title) {
    final t = title.toLowerCase();
    if (t.contains('korean') || t.contains('Korean') ||
        t.contains('language') || t.contains('standup')) return TaskTag.korean;
    if (t.contains('quiz') || t.contains('test') ||
        t.contains('study') || t.contains('yoga') ||
        t.contains('water') || t.contains('plant')) return TaskTag.calculus;
    if (t.contains('practice') || t.contains('music') ||
        t.contains('scale') || t.contains('symphony')) return TaskTag.trombone;
    if (t.contains('rocket') || t.contains('3D Print') ||
        t.contains('PID') || t.contains('Firmware') ||
        t.contains('plane') || t.contains('Firmware')) return TaskTag.projects;
    return TaskTag.other;
  }
}