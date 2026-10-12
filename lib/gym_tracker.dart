import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// The gym switch. Pressing it records the time on the phone first (so it works with no signal), and every
/// recorded session is sent to the server whenever a connection allows. Sending is safe to repeat: the server
/// keys each session by the id made here.
///
/// Stored on the phone: the session in progress (`open`) and a list of sessions the server has not confirmed
/// (`pending`). A finished session stays in `pending` until the server says it has it.
class GymTracker {
  static const _openKey = 'gym_open';
  static const _pendingKey = 'gym_pending';

  /// Sends one session; returns true only when the server confirmed it.
  final Future<bool> Function(String id, DateTime started, DateTime? ended) send;
  final DateTime Function() clock;

  GymTracker({required this.send, DateTime Function()? clock}) : clock = clock ?? DateTime.now;

  String? _openId;
  DateTime? _openStart;
  // id -> [started, ended or null]
  final Map<String, List<DateTime?>> _pending = {};
  bool _flushing = false;

  bool get atGym => _openId != null;
  DateTime? get since => _openStart;

  /// How many sessions (or session ends) the server has not confirmed yet.
  int get unsynced => _pending.length;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final open = prefs.getString(_openKey);
    if (open != null) {
      final m = jsonDecode(open) as Map<String, dynamic>;
      _openId = m['id'] as String;
      _openStart = DateTime.parse(m['started'] as String);
    }
    final pending = prefs.getString(_pendingKey);
    if (pending != null) {
      for (final e in (jsonDecode(pending) as List).cast<Map<String, dynamic>>()) {
        _pending[e['id'] as String] = [
          DateTime.parse(e['started'] as String),
          e['ended'] == null ? null : DateTime.parse(e['ended'] as String),
        ];
      }
    }
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    if (_openId == null) {
      await prefs.remove(_openKey);
    } else {
      await prefs.setString(_openKey, jsonEncode({'id': _openId, 'started': _openStart!.toUtc().toIso8601String()}));
    }
    await prefs.setString(
      _pendingKey,
      jsonEncode([
        for (final e in _pending.entries)
          {
            'id': e.key,
            'started': e.value[0]!.toUtc().toIso8601String(),
            'ended': e.value[1]?.toUtc().toIso8601String(),
          },
      ]),
    );
  }

  /// Starts a session, or ends the one in progress. Recorded on the phone before anything is sent.
  Future<void> toggle() async {
    final now = clock();
    if (_openId == null) {
      _openId = 'g${now.toUtc().millisecondsSinceEpoch}';
      _openStart = now;
      _pending[_openId!] = [now, null];
    } else {
      _pending[_openId!] = [_openStart, now];
      _openId = null;
      _openStart = null;
    }
    await _save();
    await flush();
  }

  /// Sends everything the server has not confirmed. Failures are kept for the next try; never throws.
  Future<void> flush() async {
    if (_flushing || _pending.isEmpty) return;
    _flushing = true;
    try {
      for (final id in _pending.keys.toList()) {
        final sent = _pending[id]!;
        bool ok;
        try {
          ok = await send(id, sent[0]!, sent[1]);
        } catch (_) {
          ok = false;
        }
        if (!ok) break; // no connection: the rest would fail too
        // If it changed while sending (he stopped the session mid-flight), keep it for another send.
        final latest = _pending[id];
        if (latest != null && latest[1] == sent[1]) _pending.remove(id);
      }
      await _save();
    } finally {
      _flushing = false;
    }
  }
}
