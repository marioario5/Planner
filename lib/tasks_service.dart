import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'gym_tracker.dart' show RemoteState;
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
    final now = plannerDay();
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

  /// Today's plan: tasks (timed ones in clock order, untimed last, including
  /// ones already checked off) plus the headline and info sections Claude wrote.
  /// Throws [TasksException] if the server can't be reached.
  static Future<DayPlan> fetchDay() async {
    if (!isConfigured) throw const TasksException('not connected');

    try {
      final res = await http
          .get(Uri.parse('$_baseUrl/api/tasks?date=${_today()}'), headers: _headers)
          .timeout(_timeout);
      if (res.statusCode != 200) throw _statusError(res);

      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final tasks = (body['tasks'] as List)
          .cast<Map<String, dynamic>>()
          .map((t) => Task(
                id: t['id'] as String,
                label: t['title'] as String,
                done: t['done'] as bool,
                tag: _tagFromName(t['tag'] as String?),
                plan: (t['plan'] as String?) == 'B' ? 'B' : 'A', // absent on an older server
                start: t['start'] as String?,
                minutes: t['minutes'] as int?,
                notes: t['notes'] as String?,
                // Both absent on a server that predates the Start button and flag.
                startedAt: DateTime.tryParse((t['started'] as String?) ?? '')?.toLocal(),
                completedAt: DateTime.tryParse((t['completed'] as String?) ?? '')?.toLocal(),
                pausedAt: DateTime.tryParse((t['paused'] as String?) ?? '')?.toLocal(),
                pausedMs: (t['paused_ms'] as int?) ?? 0,
                flagged: (t['flagged'] as bool?) ?? false,
              ))
          .toList();
      // `sections` is absent on a server that predates info sections.
      final sections = ((body['sections'] as List?) ?? const [])
          .cast<Map<String, dynamic>>()
          .map((s) => InfoSection(
                title: s['title'] as String,
                body: s['body'] as String,
              ))
          .toList();
      return DayPlan(
        tasks: tasks,
        headline: body['headline'] as String?,
        sections: sections,
        rating: body['rating'] as int?,
      );
    } on TasksException {
      rethrow;
    } on FormatException {
      throw const TasksException('bad server address');
    } catch (e) {
      debugPrint('Tasks fetch error: $e');
      throw const TasksException("can't reach server");
    }
  }

  static Future<bool> _patchTask(Task task, Map<String, dynamic> body) async {
    if (!isConfigured) return false;

    try {
      final res = await http
          .patch(
            Uri.parse('$_baseUrl/api/tasks/${Uri.encodeComponent(task.id)}'),
            headers: _headers,
            body: jsonEncode(body),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('Task update error: $e');
      return false;
    }
  }

  /// Unticking also clears the Start press, so the task starts over.
  /// With [restore] (ticking again right after an accidental untick) the server puts the old Start press and
  /// finish time back instead of stamping "now".
  static Future<bool> setTaskCompleted(Task task, bool completed, {UntickUndo? restore}) => _patchTask(task, {
        'done': completed,
        if (!completed) 'started': false,
        if (completed && restore?.startedAt != null) 'restoreStarted': restore!.startedAt!.toUtc().toIso8601String(),
        if (completed && restore?.completedAt != null) 'restoreCompleted': restore!.completedAt!.toUtc().toIso8601String(),
        if (completed && restore != null) 'restorePausedMs': restore.pausedMs,
      });

  /// Records (or clears) the moment he pressed Start. The server keeps the first press.
  static Future<bool> setTaskStarted(Task task, bool started) =>
      _patchTask(task, {'started': started});

  /// Pauses (or resumes) a started task. Time paused is not counted in how long the block took.
  static Future<bool> setTaskPaused(Task task, bool paused) =>
      _patchTask(task, {'paused': paused});

  /// Flags (or unflags) a task whose start or finish time is wrong.
  static Future<bool> setTaskFlagged(Task task, bool flagged) =>
      _patchTask(task, {'flagged': flagged});

  /// Sends one gym session (the server keeps it by [id], so sending twice is harmless). True once the server has it.
  static Future<bool> putGym(String id, DateTime started, DateTime? ended, [String? mode]) async {
    if (!isConfigured) return false;

    try {
      final res = await http
          .put(
            Uri.parse('$_baseUrl/api/gym/${Uri.encodeComponent(id)}'),
            headers: _headers,
            body: jsonEncode({
              'started': started.toUtc().toIso8601String(),
              'ended': ended?.toUtc().toIso8601String(),
            }),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('Gym send error: $e');
      return false;
    }
  }

  /// Sends one YouTube-mode stretch (the music experiment). Same rules as [putGym]: safe to repeat, true once the server has it.
  static Future<bool> putMusic(String id, DateTime started, DateTime? ended, [String? mode]) async {
    if (!isConfigured) return false;

    try {
      final res = await http
          .put(
            Uri.parse('$_baseUrl/api/music/${Uri.encodeComponent(id)}'),
            headers: _headers,
            body: jsonEncode({
              'started': started.toUtc().toIso8601String(),
              'ended': ended?.toUtc().toIso8601String(),
              'mode': mode ?? 'browsing',
            }),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('Music send error: $e');
      return false;
    }
  }

  /// What YouTube mode is on right now, according to the server (it may have been changed from the website).
  static Future<RemoteState> getMusicCurrent() async {
    if (!isConfigured) return const RemoteState(reachable: false);
    try {
      final res = await http.get(Uri.parse('$_baseUrl/api/music/current'), headers: _headers).timeout(_timeout);
      if (res.statusCode != 200) return const RemoteState(reachable: false);
      final current = (jsonDecode(res.body) as Map<String, dynamic>)['current'] as Map<String, dynamic>?;
      if (current == null) return const RemoteState(reachable: true);
      return RemoteState(
        reachable: true,
        id: current['id'] as String,
        started: DateTime.tryParse(current['started'] as String? ?? '')?.toLocal(),
        mode: current['mode'] as String?,
      );
    } catch (e) {
      debugPrint('Music state error: $e');
      return const RemoteState(reachable: false);
    }
  }

  /// How today felt, 1 to 5; null clears it.
  static Future<bool> setRating(int? rating) async {
    if (!isConfigured) return false;

    try {
      final res = await http
          .put(
            Uri.parse('$_baseUrl/api/rating'),
            headers: _headers,
            body: jsonEncode({'date': _today(), 'rating': rating}),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (e) {
      debugPrint('Rating error: $e');
      return false;
    }
  }
}
