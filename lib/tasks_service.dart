import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'task_model.dart';

/// Thrown with a message that is safe to show on screen.
class TasksException implements Exception {
  final String message;
  const TasksException(this.message);
  @override
  String toString() => message;
}

/// Talks to the planner server (see /server). Claude publishes the day's list
/// there through MCP; this app reads it and writes check-offs back.
class TasksService {
  static const _urlKey = 'planner_server_url';
  static const _tokenKey = 'planner_server_token';
  static const _timeout = Duration(seconds: 15);

  static String? _baseUrl;
  static String? _token;

  static String? get baseUrl => _baseUrl;
  static String? get token => _token;
  static bool get isConfigured =>
      (_baseUrl?.isNotEmpty ?? false) && (_token?.isNotEmpty ?? false);

  /// Reads the saved server address and token. Call once at startup.
  static Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _baseUrl = prefs.getString(_urlKey);
    _token = prefs.getString(_tokenKey);
  }

  static Future<void> saveConfig(String url, String token) async {
    var cleaned = url.trim();
    if (cleaned.isNotEmpty && !cleaned.contains('://')) cleaned = 'https://$cleaned';
    cleaned = cleaned.replaceAll(RegExp(r'/+$'), '');

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_urlKey, cleaned);
    await prefs.setString(_tokenKey, token.trim());
    _baseUrl = cleaned;
    _token = token.trim();
  }

  static Future<void> clearConfig() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_urlKey);
    await prefs.remove(_tokenKey);
    _baseUrl = null;
    _token = null;
  }

  static Map<String, String> get _headers => {
        'Authorization': 'Bearer $_token',
        'Content-Type': 'application/json',
      };

  static String _today() {
    final now = DateTime.now();
    final m = now.month.toString().padLeft(2, '0');
    final d = now.day.toString().padLeft(2, '0');
    return '${now.year}-$m-$d';
  }

  static TaskTag _tagFromName(String? name) {
    return TaskTag.values.firstWhere(
      (tag) => tag.name == name,
      orElse: () => TaskTag.school,
    );
  }

  static TasksException _statusError(http.Response res) {
    if (res.statusCode == 401) return const TasksException('wrong token');
    return TasksException('server error (${res.statusCode})');
  }

  /// Today's tasks, in the order Claude listed them, including ones already
  /// checked off. Throws [TasksException] if the server can't be reached.
  static Future<List<Task>> fetchTasks() async {
    if (!isConfigured) throw const TasksException('not connected');

    try {
      final res = await http
          .get(Uri.parse('$_baseUrl/api/tasks?date=${_today()}'), headers: _headers)
          .timeout(_timeout);
      if (res.statusCode != 200) throw _statusError(res);

      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return (body['tasks'] as List)
          .cast<Map<String, dynamic>>()
          .map((t) => Task(
                id: t['id'] as String,
                label: t['title'] as String,
                done: t['done'] as bool,
                tag: _tagFromName(t['tag'] as String?),
              ))
          .toList();
    } on TasksException {
      rethrow;
    } on FormatException {
      throw const TasksException('bad server address');
    } catch (e) {
      debugPrint('Tasks fetch error: $e');
      throw const TasksException("can't reach server");
    }
  }

  static Future<bool> setTaskCompleted(Task task, bool completed) async {
    if (!isConfigured) return false;

    try {
      final res = await http
          .patch(
            Uri.parse('$_baseUrl/api/tasks/${Uri.encodeComponent(task.id)}'),
            headers: _headers,
            body: jsonEncode({'done': completed}),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('Task update error: $e');
      return false;
    }
  }
}
