import 'dart:convert';

import 'package:google_sign_in/google_sign_in.dart';
import 'package:googleapis/tasks/v1.dart' as gtasks;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

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

  static const _completedTasksCacheKey = 'google_tasks_completed_cache';
  static final Duration _pstOffset = const Duration(hours: -8);

  static DateTime _nowUtc() => DateTime.now().toUtc();

  static DateTime _pstMidnightUtc(DateTime utc) {
    final pst = utc.add(_pstOffset);
    final pstMidnight = DateTime.utc(pst.year, pst.month, pst.day);
    return pstMidnight.subtract(_pstOffset);
  }

  static DateTime _endOfPstDayUtc() {
    final nowUtc = _nowUtc();
    return _pstMidnightUtc(nowUtc).add(const Duration(days: 1));
  }

  static String _completedTaskKey(String listId, String taskId) => '$listId|$taskId';

  static Future<Map<String, dynamic>> _loadCompletedTasksCache() async {
    final prefs = await SharedPreferences.getInstance();
    final rawJson = prefs.getString(_completedTasksCacheKey);
    if (rawJson == null) return {};

    try {
      final decoded = jsonDecode(rawJson);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {
      // ignore malformed cache
    }
    return {};
  }

  static Future<void> _saveCompletedTasksCache(Map<String, dynamic> cache) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_completedTasksCacheKey, jsonEncode(cache));
  }

  static TaskTag _tagFromName(String name) {
    return TaskTag.values.firstWhere(
      (tag) => tag.name == name,
      orElse: () => TaskTag.other,
    );
  }

  static Task? _taskFromCacheEntry(Map<String, dynamic> entry) {
    final id = entry['id'] as String?;
    final listId = entry['listId'] as String?;
    final label = entry['label'] as String?;
    final tagName = entry['tag'] as String?;
    final expiresAt = entry['expiresAt'] as String?;
    if (id == null || listId == null || label == null || tagName == null || expiresAt == null) {
      return null;
    }
    final expiry = DateTime.tryParse(expiresAt);
    if (expiry == null || expiry.isBefore(_nowUtc())) return null;

    return Task(
      id: id,
      listId: listId,
      label: label,
      done: true,
      tag: _tagFromName(tagName),
    );
  }

  static Future<Map<String, dynamic>> _pruneExpiredCompletedTasksCache() async {
    final cache = await _loadCompletedTasksCache();
    final nowUtc = _nowUtc();
    final expiredKeys = <String>[];
    for (final entry in cache.entries) {
      final expiresAt = entry.value is Map<String, dynamic>
          ? entry.value['expiresAt'] as String?
          : null;
      if (expiresAt == null) {
        expiredKeys.add(entry.key);
        continue;
      }
      final expiry = DateTime.tryParse(expiresAt);
      if (expiry == null || expiry.isBefore(nowUtc)) {
        expiredKeys.add(entry.key);
      }
    }
    if (expiredKeys.isNotEmpty) {
      for (final key in expiredKeys) {
        cache.remove(key);
      }
      await _saveCompletedTasksCache(cache);
    }
    return cache;
  }

  static Future<List<Task>> fetchTasks() async {
    if (currentUser == null) return [];

    try {
      final cache = await _pruneExpiredCompletedTasksCache();
      final completedTasks = cache.values
          .whereType<Map<String, dynamic>>()
          .map(_taskFromCacheEntry)
          .whereType<Task>()
          .toList();

      final auth = await currentUser!.authentication;
      final accessToken = auth.accessToken;
      if (accessToken == null) return completedTasks;

      final client = _AuthClient({
        'Authorization': 'Bearer $accessToken',
        'X-Goog-AuthUser': '0',
      });

      final api = gtasks.TasksApi(client);
      final lists = await api.tasklists.list();
      final result = <Task>[];
      final existingKeys = <String>{};

      for (final task in completedTasks) {
        existingKeys.add(_completedTaskKey(task.listId, task.id));
      }

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
          final taskId = t.id ?? DateTime.now().millisecondsSinceEpoch.toString();
          final taskKey = _completedTaskKey(list.id!, taskId);
          if (existingKeys.contains(taskKey)) continue;

          result.add(Task(
            id: taskId,
            listId: list.id!,
            label: t.title!,
            tag: _tagFromTitle(t.title!),
          ));
        }
      }

      result.addAll(completedTasks);
      return result;
    } catch (e) {
      print('Tasks fetch error: $e');
      return [];
    }
  }

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

      final cache = await _loadCompletedTasksCache();
      final key = _completedTaskKey(task.listId, task.id);
      if (completed) {
        cache[key] = {
          'id': task.id,
          'listId': task.listId,
          'label': task.label,
          'tag': task.tag.name,
          'expiresAt': _endOfPstDayUtc().toIso8601String(),
        };
      } else {
        cache.remove(key);
      }
      await _saveCompletedTasksCache(cache);

      return true;
    } catch (e) {
      print('Task update error: $e');
      return false;
    }
  }

  static TaskTag _tagFromTitle(String title) {
    final t = title.toLowerCase();
    if (t.contains('korean') || t.contains('Korean') ||
        t.contains('language') || t.contains('learn')) {
      return TaskTag.korean;
    }
    if (t.contains('quiz') || t.contains('test') ||
        t.contains('study') || t.contains('yoga') ||
        t.contains('water') || t.contains('plant')) {
      return TaskTag.calculus;
    }
    if (t.contains('practice') || t.contains('music') ||
        t.contains('scale') || t.contains('trombone')) {
      return TaskTag.trombone;
    }
    if (t.contains('rocket') || t.contains('3D Print') ||
        t.contains('PID') || t.contains('PCB') ||
        t.contains('plane') || t.contains('machine')) {
      return TaskTag.projects;
    }
    return TaskTag.other;
  }
}