import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// An on/off switch that records stretches of time (the gym switch, and the printer button for YouTube mode). Pressing it records the time
/// on the phone first (so it works with no signal), and every recorded session is sent to the server whenever a connection allows.
/// Sending is safe to repeat: the server keys each session by the id made here.
///
/// A session can carry a `mode` (YouTube mode: browsing or lecture). [advance] steps through the modes in order: off, first mode, next mode, ...,
/// off. Changing mode ends the current session and starts the next one at the same instant.
///
/// Stored on the phone: the session in progress (`open`) and a list of sessions the server has not confirmed
/// (`pending`). A finished session stays in `pending` until the server says it has it.
class GymTracker {
  /// Which switch this is: `gym` (the default) or `music`. It names the saved state, so the two never mix.
  final String name;
  String get _openKey => '${name}_open';
  String get _pendingKey => '${name}_pending';

  /// Sends one session; returns true only when the server confirmed it. `mode` is null for the gym.
  final Future<bool> Function(String id, DateTime started, DateTime? ended, String? mode) send;
  final DateTime Function() clock;

  GymTracker({required this.send, DateTime Function()? clock, this.name = 'gym'}) : clock = clock ?? DateTime.now;

  String? _openId;
  DateTime? _openStart;
  String? _openMode;
  // id -> [started, ended or null, mode or null]
  final Map<String, List<Object?>> _pending = {};
  bool _flushing = false;
  int _seq = 0; // keeps two ids made in the same millisecond apart

  bool get atGym => _openId != null;
  DateTime? get since => _openStart;

  /// The mode of the session in progress, or null when off.
  String? get mode => _openId == null ? null : _openMode;

  /// How many sessions (or session ends) the server has not confirmed yet.
  int get unsynced => _pending.length;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final open = prefs.getString(_openKey);
    if (open != null) {
      final m = jsonDecode(open) as Map<String, dynamic>;
      _openId = m['id'] as String;
      _openStart = DateTime.parse(m['started'] as String);
      _openMode = m['mode'] as String?;
    }
    final pending = prefs.getString(_pendingKey);
    if (pending != null) {
      for (final e in (jsonDecode(pending) as List).cast<Map<String, dynamic>>()) {
        _pending[e['id'] as String] = [
          DateTime.parse(e['started'] as String),
          e['ended'] == null ? null : DateTime.parse(e['ended'] as String),
          e['mode'] as String?,
        ];
      }
    }
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    if (_openId == null) {
      await prefs.remove(_openKey);
    } else {
      await prefs.setString(
        _openKey,
        jsonEncode({'id': _openId, 'started': _openStart!.toUtc().toIso8601String(), 'mode': _openMode}),
      );
    }
    await prefs.setString(
      _pendingKey,
      jsonEncode([
        for (final e in _pending.entries)
          {
            'id': e.key,
            'started': (e.value[0]! as DateTime).toUtc().toIso8601String(),
            'ended': (e.value[1] as DateTime?)?.toUtc().toIso8601String(),
            'mode': e.value[2],
          },
      ]),
    );
  }

  void _start(DateTime now, String? mode) {
    _openId = '${name.substring(0, 1)}${now.toUtc().millisecondsSinceEpoch}${_seq++}';
    _openStart = now;
    _openMode = mode;
    _pending[_openId!] = [now, null, mode];
  }

  void _end(DateTime now) {
    _pending[_openId!] = [_openStart, now, _openMode];
    _openId = null;
    _openStart = null;
    _openMode = null;
  }

  /// Starts a session (with [mode], if any), or ends the one in progress. Recorded on the phone before anything is sent.
  Future<void> toggle({String? mode}) async {
    final now = clock();
    if (_openId == null) {
      _start(now, mode);
    } else {
      _end(now);
    }
    await _save();
    await flush();
  }

  /// Steps to the next mode in [order]: off -> order[0] -> order[1] -> ... -> off. Moving between modes ends one session and starts the next
  /// at the same moment, so no time is lost or counted twice.
  Future<void> advance(List<String> order) async {
    final now = clock();
    if (_openId == null) {
      _start(now, order.first);
    } else {
      final next = order.indexOf(_openMode ?? order.first) + 1;
      _end(now);
      if (next < order.length) _start(now, order[next]);
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
          ok = await send(id, sent[0]! as DateTime, sent[1] as DateTime?, sent[2] as String?);
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
