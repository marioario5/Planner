import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:math';
import 'dart:convert';
import 'task_model.dart';
import 'printer_painter.dart';
import 'tasks_service.dart';

const Color cPaper       = Color(0xFFFFF8EE);
const Color cPaperShadow = Color(0xFFEDE0CC);
const Color cInk         = Color(0xFF2D1B00);
const Color cInkLight    = Color(0xFF5C3D1E);
const Color cRose        = Color(0xFFE8A0A0);
const Color cSage        = Color(0xFF8BAF7C);
const Color cAmber       = Color(0xFFD4A843);
const Color cTeal        = Color(0xFF6C8EBF);
const Color cLavender    = Color(0xFF9C7BBC );
const Color cBg          = Color(0xFFC8B89A);
const Color cBgDark      = Color(0xFFA8966E);

Color tagColor(TaskTag tag) {
  switch (tag) {
    case TaskTag.school:      return cAmber;
    case TaskTag.calculus3:   return cRose;
    case TaskTag.sat:         return cLavender;
    case TaskTag.pcb:         return cTeal;
    case TaskTag.photography: return cSage;
  }
}

TextStyle _px(double size, Color color,
        {double height = 1.8, double? letterSpacing, TextDecoration? decoration}) =>
    GoogleFonts.pressStart2p(
        fontSize: size,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
        decoration: decoration,
        decorationColor: color);

/// A checklist line: "[ ] item", "- [ ] item" or "* [ ] item".
final _checkRe = RegExp(r'^\s*(?:[-*]\s*)?\[[ xX]?\]\s+(.*)$');

List<String> _checkItems(String body) => [
      for (final line in body.split('\n'))
        if (_checkRe.hasMatch(line)) _checkRe.firstMatch(line)!.group(1)!.trim(),
    ];

/// Plain-text block from Claude. "[ ] item" lines become tickable boxes, lines
/// starting with "- " or "* " get a bullet, everything else is plain text.
class _InfoBody extends StatelessWidget {
  final String text;
  final String section;
  final Set<String> ticks;
  final void Function(String key)? onTick;
  const _InfoBody(this.text,
      {this.section = '', this.ticks = const {}, this.onTick});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final raw in text.split('\n'))
          if (raw.trim().isNotEmpty) _line(raw),
      ],
    );
  }

  Widget _line(String raw) {
    final check = _checkRe.firstMatch(raw);
    if (check != null && onTick != null) {
      final item = check.group(1)!.trim();
      final key = '$section|$item';
      final ticked = ticks.contains(key);
      final dim = cInkLight.withValues(alpha: 0.6);
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onTick!(key),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 12, height: 12,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                color: ticked ? cSage : cPaper,
                border: Border.all(color: ticked ? cSage : cInk, width: 2),
              ),
              child: ticked
                  ? const Icon(Icons.check, size: 8, color: Colors.white)
                  : null,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(item,
                  style: _px(5, ticked ? dim : cInk,
                      height: 2,
                      decoration:
                          ticked ? TextDecoration.lineThrough : null)),
            ),
          ]),
        ),
      );
    }
    final bullet = RegExp(r'^\s*[-*] ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: bullet.hasMatch(raw)
          ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('• ', style: _px(5, cInkLight, height: 2)),
              Expanded(
                child: Text(raw.replaceFirst(bullet, ''),
                    style: _px(5, cInk, height: 2)),
              ),
            ])
          : Text(raw.trim(), style: _px(5, cInk, height: 2)),
    );
  }
}

class PlannerScreen extends StatefulWidget {
  const PlannerScreen({super.key});
  @override
  State<PlannerScreen> createState() => _PlannerScreenState();
}

class _PlannerScreenState extends State<PlannerScreen>
    with TickerProviderStateMixin {

  late AnimationController _lightController;
  late AnimationController _feedController;

  bool _printed   = false;
  bool _loading   = false;
  String? _error;
  String _vibe    = 'Matthew 11:29';

  List<Task> _tasks = [];            // every plan's tasks for today
  String? _headline;
  List<InfoSection> _sections = [];
  String _plan = 'A';                // which plan is showing
  Set<String> _ticks = {};           // ticked checklist items, "Section|item"

  List<Task> get _planTasks => _tasks.where((t) => t.plan == _plan).toList();
  bool get _hasPlanB => _tasks.any((t) => t.plan == 'B');

  @override
  void initState() {
    super.initState();
    _lightController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat();

    // Slow feed — 4 seconds, ease-out so it feels mechanical
    _feedController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 4000),
    );

    // Pick up the saved server address and token on launch
    _loadConnection();
    _loadVibe();
    _loadTicks();
  }

  Future<void> _loadConnection() async {
    await TasksService.load();
    if (mounted) setState(() {});
  }

  Future<void> _loadVibe() async {
    final prefs = await SharedPreferences.getInstance();
    final today = DateTime.now();
    final todayKey = '${today.year}-${today.month}-${today.day}';
    final savedDate = prefs.getString('vibe_date');
    final savedVibe = prefs.getString('vibe_text');

    if (savedDate == todayKey && savedVibe != null) {
      // Same day — use the saved vibe
      if (mounted) setState(() => _vibe = savedVibe);
      return;
    }

    // New day — pick a fresh one
    final data = await rootBundle.loadString('assets/vibes.json');
    final json = jsonDecode(data);
    final vibes = List<String>.from(json['vibes']);
    final pick = vibes[Random().nextInt(vibes.length)];
    await prefs.setString('vibe_date', todayKey);
    await prefs.setString('vibe_text', pick);
    if (mounted) setState(() => _vibe = pick);
  }

  @override
  void dispose() {
    _lightController.dispose();
    _feedController.dispose();
    super.dispose();
  }

  int get _doneCount => _planTasks.where((t) => t.done).length;

  String get _progressMessage {
    final total = _planTasks.length;
    final done  = _doneCount;
    if (done == 0 || total == 0) return '';
    if (done == total) return '✦✦ YOU DID IT! ✦✦';
    if (done >= (total * 0.85).ceil()) return '✦ one more!';
    if (done >= (total * 0.7).ceil())  return '✦ almost done!';
    if (done >= (total * 0.5).ceil())  return '✦ halfway there!';
    return '';
  }

  String get _dateLabel {
    final days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    final months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    final now    = plannerDay();
    return '${days[now.weekday % 7]}, ${months[now.month - 1]} ${now.day}';
  }

  Future<void> _toggleTask(Task task) async {
    HapticFeedback.lightImpact();
    final newDone = !task.done;
    setState(() => task.done = newDone);

    final ok = await TasksService.setTaskCompleted(task, newDone);
    if (!ok && mounted) {
      // Couldn't reach the server — revert the checkbox so the UI
      // doesn't claim it's synced when it isn't.
      setState(() {
        task.done = !newDone;
        _error = "Couldn't sync that change";
      });
    }
  }

  void _deleteTask(Task task) {
    HapticFeedback.mediumImpact();
    setState(() => _tasks.remove(task));
  }

  /// Asks for the planner server address and token. Returns true if saved.
  Future<bool> _showConnectDialog() async {
    final urlCtrl   = TextEditingController(text: TasksService.baseUrl ?? '');
    final tokenCtrl = TextEditingController(text: TasksService.token ?? '');

    TextStyle label(double size, Color color) =>
        GoogleFonts.pressStart2p(fontSize: size, color: color, height: 1.8);

    InputDecoration field(String hint) => InputDecoration(
      hintText: hint,
      hintStyle: label(6, cInkLight.withValues(alpha: 0.4)),
      isDense: true,
      enabledBorder: const OutlineInputBorder(
          borderRadius: BorderRadius.zero,
          borderSide: BorderSide(color: cInkLight, width: 2)),
      focusedBorder: const OutlineInputBorder(
          borderRadius: BorderRadius.zero,
          borderSide: BorderSide(color: cInk, width: 2)),
    );

    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: cPaper,
        shape: const RoundedRectangleBorder(
            side: BorderSide(color: cInk, width: 2)),
        title: Text('connect planner', style: label(8, cInk)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('server address', style: label(6, cInkLight)),
            const SizedBox(height: 6),
            TextField(
              controller: urlCtrl,
              keyboardType: TextInputType.url,
              autocorrect: false,
              style: label(6, cInk),
              decoration: field('your-worker.workers.dev'),
            ),
            const SizedBox(height: 14),
            Text('token', style: label(6, cInkLight)),
            const SizedBox(height: 6),
            TextField(
              controller: tokenCtrl,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              style: label(6, cInk),
              decoration: field('API_TOKEN'),
            ),
          ],
        ),
        actions: [
          if (TasksService.isConfigured)
            TextButton(
              onPressed: () => Navigator.pop(ctx, 'disconnect'),
              child: Text('DISCONNECT', style: label(6, cRose)),
            ),
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('CANCEL', style: label(6, cInkLight)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'save'),
            child: Text('SAVE', style: label(6, cInk)),
          ),
        ],
      ),
    );

    final url   = urlCtrl.text;
    final token = tokenCtrl.text;
    urlCtrl.dispose();
    tokenCtrl.dispose();

    if (result == 'disconnect') {
      await TasksService.clearConfig();
      if (mounted) {
        setState(() {
          _tasks = [];
          _headline = null;
          _sections = [];
          _plan = 'A';
          _printed = false;
          _error = null;
        });
      }
      return false;
    }
    if (result == 'save' && url.trim().isNotEmpty && token.trim().isNotEmpty) {
      await TasksService.saveConfig(url, token);
      if (mounted) setState(() => _error = null);
      return true;
    }
    return false;
  }

  Future<void> _printPaper() async {
    if (!TasksService.isConfigured) {
      final saved = await _showConnectDialog();
      if (!saved || !mounted) return;
    }

    HapticFeedback.mediumImpact();
    setState(() { _loading = true; _error = null; });

    DayPlan plan;
    try {
      plan = await TasksService.fetchDay();
    } on TasksException catch (e) {
      // Don't print an empty receipt for a network failure — it would read
      // as "no tasks, enjoy the free time".
      if (mounted) setState(() { _loading = false; _error = e.message; });
      return;
    }

    if (!mounted) return;
    setState(() {
      _loading   = false;
      _tasks     = plan.tasks;
      _headline  = plan.headline;
      _sections  = plan.sections;
      _printed   = true;
      // Keep the plan he was on if it still exists; otherwise A, or B if A is empty.
      final hasA = _tasks.any((t) => t.plan == 'A');
      if (!_tasks.any((t) => t.plan == _plan)) _plan = hasA || !_hasPlanB ? 'A' : 'B';
    });

    _feedController.reset();
    _feedController.forward();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: cBg,
      body: Stack(children: [
        const _GridBackground(),
        const _DecoScene(),

        Column(children: [
          // ── STICKY PRINTER (pinned at top, never scrolls) ──────────────
          SafeArea(
            bottom: false,
            child: Column(children: [
              const SizedBox(height: 16),
              Text(
                '✦ daily tasks ✦',
                style: GoogleFonts.pressStart2p(
                  fontSize: 7,
                  color: const Color(0xFF4A3728).withValues(alpha: 0.55),
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: GestureDetector(
                  // Long-press the printer to change the server or
                  // disconnect — keeps the UI free of a settings button.
                  onLongPress: _showConnectDialog,
                  child: AnimatedBuilder(
                    animation: _lightController,
                    builder: (_, __) => CustomPaint(
                      size: const Size(320, 108),
                      painter: PrinterPainter(blinkPhase: _lightController.value),
                    ),
                  ),
                ),
              ),
            ]),
          ),

          // ── SCROLLABLE PAPER ─────────────────────────────────────────
          Expanded(
            child: SingleChildScrollView(
              child: Center(
                child: Column(children: [
                  if (_printed)
                    AnimatedBuilder(
                      animation: _feedController,
                      builder: (_, child) {
                        final curved = Curves.easeOut
                            .transform(_feedController.value);
                        // Align to BOTTOM so the paper feeds downward —
                        // bottom of receipt shows first, rest emerges as
                        // heightFactor grows, mimicking a real printer feed.
                        return ClipRect(
                          child: Align(
                            alignment: Alignment.bottomCenter,
                            heightFactor: curved,
                            child: child,
                          ),
                        );
                      },
                      child: _buildPaper(),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 40),
                      child: Text(
                        TasksService.isConfigured
                            ? 'hit print to\nfetch your tasks'
                            : 'connect to your\nplanner server',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.pressStart2p(
                          fontSize: 6,
                          color: const Color(0xFF4A3728).withValues(alpha: 0.4),
                          height: 2,
                        ),
                      ),
                    ),

                  const SizedBox(height: 100),
                ]),
              ),
            ),
          ),
        ]),
      ]),

      // ── FIXED BOTTOM PRINT BUTTON ────────────────────────────────────
      bottomNavigationBar: SafeArea(
        child: Container(
          color: cBg,
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_error != null) ...[
                Text(_error!,
                    style: GoogleFonts.pressStart2p(
                        fontSize: 5, color: cRose)),
                const SizedBox(height: 8),
              ],
              _sectionButtons(),
              _loading
                ? Center(
                    child: Text('fetching tasks...',
                        style: GoogleFonts.pressStart2p(
                            fontSize: 6, color: cInkLight)),
                  )
                : GestureDetector(
                    onTap: _printPaper,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 20, vertical: 12),
                      decoration: BoxDecoration(
                        color: const Color(0xFF4A3728),
                        border: Border.all(
                            color: const Color(0xFF2e1a08), width: 2),
                      ),
                      child: Text(
                        !TasksService.isConfigured
                            ? '[ CONNECT & PRINT ]'
                            : _printed ? '[ REPRINT ]' : '[ PRINT ]',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.pressStart2p(
                            fontSize: 7, color: cPaper, letterSpacing: 1),
                      ),
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Paper receipt ───────────────────────────────────────────────────────

  Widget _buildPaper() {
    return SizedBox(
      width: 260,
      child: Column(children: [
        _buildPerforation(),
        Container(
          width: 260,
          decoration: const BoxDecoration(
            color: cPaper,
            border: Border(
              left:  BorderSide(color: cPaperShadow, width: 4),
              right: BorderSide(color: cPaperShadow, width: 4),
            ),
          ),
          child: Stack(children: [
            Positioned.fill(child: CustomPaint(painter: _ScanLinesPainter())),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
              child: Column(children: [
                // Header
                Text("Today's Tasks",
                    textAlign: TextAlign.center,
                    style: GoogleFonts.pressStart2p(
                        fontSize: 8, color: cInk,
                        letterSpacing: 1, height: 1.8)),
                const SizedBox(height: 4),
                const Text('🌿 ☕ 🌿',
                    style: TextStyle(fontSize: 14, letterSpacing: 4)),
                const SizedBox(height: 4),
                Text(_dateLabel,
                    style: GoogleFonts.pressStart2p(
                        fontSize: 6, color: cInkLight, height: 2)),
                const SizedBox(height: 14),
                _dashedDivider(color: cInkLight),
                const SizedBox(height: 14),

                // Mood
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _moodPip(), const SizedBox(width: 6),
                  Text(_vibe,
                      style: GoogleFonts.pressStart2p(
                          fontSize: 5, color: cInkLight, letterSpacing: 0.5)),
                  const SizedBox(width: 6), _moodPip(),
                ]),
                const SizedBox(height: 10),
                _dashedDivider(),
                const SizedBox(height: 14),

                _buildTaskSide(),
              ]),
            ),
          ]),
        ),
        _buildTear(),
        Center(
          child: Container(
            width: 234, height: 8,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
        ),
      ]),
    );
  }

  // ── Receipt ─────────────────────────────────────────────────────────────

  Widget _planChip(String p) {
    final selected = _plan == p;
    final starts = _tasks
        .where((t) => t.plan == p && t.start != null)
        .map((t) => t.start!)
        .toList()
      ..sort();
    final label = 'PLAN $p${starts.isEmpty ? '' : '\n${formatClock(starts.first)}'}';
    return Expanded(
      child: GestureDetector(
        onTap: () {
          HapticFeedback.selectionClick();
          setState(() => _plan = p);
        },
        child: Container(
          margin: EdgeInsets.only(right: p == 'A' ? 6 : 0),
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: selected ? cInk : cPaper,
            border: Border.all(color: cInk, width: 2),
          ),
          child: Text(label,
              textAlign: TextAlign.center,
              style: _px(5, selected ? cPaper : cInk, height: 1.6)),
        ),
      ),
    );
  }

  /// The headline, the plan switcher (only when there is a Plan B), the task
  /// list for the selected plan, and progress.
  Widget _buildTaskSide() {
    final tasks = _planTasks;
    final total = tasks.length;
    final done  = _doneCount;

    return Column(children: [
      if (_headline != null) ...[
        Align(
          alignment: Alignment.centerLeft,
          child: Text(_headline!, style: _px(6, cInk, height: 2)),
        ),
        const SizedBox(height: 12),
        _dashedDivider(),
        const SizedBox(height: 12),
      ],
      if (_hasPlanB) ...[
        Row(children: [_planChip('A'), _planChip('B')]),
        const SizedBox(height: 12),
      ],
      // Tasks
      if (tasks.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Text(
            _hasPlanB ? 'nothing in plan $_plan' : 'no tasks found!\nenjoy the free time ✦',
            textAlign: TextAlign.center,
            style: GoogleFonts.pressStart2p(
                fontSize: 6, color: cInkLight, height: 2),
          ),
        )
      else
        Column(
          children: tasks.map((t) => _TaskRow(
            task: t,
            onToggle: () => _toggleTask(t),
            onDelete: () => _deleteTask(t),
          )).toList(),
        ),

      const SizedBox(height: 16),
      _dashedDivider(),
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text('🌿 ✦ 🍂',
            textAlign: TextAlign.center,
            style: GoogleFonts.pressStart2p(
                fontSize: 8, letterSpacing: 4,
                color: cPaperShadow)),
      ),
      _dashedDivider(),
      const SizedBox(height: 14),

      // Progress
      if (tasks.isNotEmpty) ...[
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
          Text('PROGRESS',
              style: GoogleFonts.pressStart2p(
                  fontSize: 5, color: cInkLight, letterSpacing: 0.5)),
          Text('$done / $total',
              style: GoogleFonts.pressStart2p(
                  fontSize: 5, color: cInkLight)),
        ]),
        const SizedBox(height: 6),
        Row(
          children: List.generate(total, (i) => Expanded(
            child: Container(
              height: 10,
              margin: const EdgeInsets.only(right: 3),
              decoration: BoxDecoration(
                color: i < done ? cSage : cPaperShadow,
                border: Border.all(
                  color: i < done
                      ? const Color(0xFF6a9060) : cBgDark,
                  width: 1,
                ),
              ),
            ),
          )),
        ),
        if (_progressMessage.isNotEmpty) ...[
          const SizedBox(height: 8),
          Center(child: Text(_progressMessage,
              style: GoogleFonts.pressStart2p(
                  fontSize: 5, color: cSage))),
        ],
      ],
    ]);
  }

  // ── Checklists inside info sections ("[ ] item" lines) ───────────────────

  String get _todayKey {
    final n = plannerDay();
    return '${n.year}-${n.month}-${n.day}';
  }

  /// Ticks live on this phone and reset each day.
  Future<void> _loadTicks() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('info_ticks');
    if (raw == null) return;
    try {
      final m = jsonDecode(raw) as Map<String, dynamic>;
      if (m['date'] == _todayKey) _ticks = Set<String>.from(m['keys'] as List);
    } catch (_) {
      // ignore a malformed save
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggleTick(String key) async {
    HapticFeedback.selectionClick();
    setState(() {
      if (!_ticks.remove(key)) _ticks.add(key);
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
        'info_ticks', jsonEncode({'date': _todayKey, 'keys': _ticks.toList()}));
  }

  /// "2/4" for a section that has checklist items, else null.
  String? _checkProgress(InfoSection s) {
    final items = _checkItems(s.body);
    if (items.isEmpty) return null;
    final done = items.where((i) => _ticks.contains('${s.title}|$i')).length;
    return '$done/${items.length}';
  }

  /// Opens one info section (warnings, pre-start, next PCB work, ...).
  Future<void> _showSection(InfoSection section) {
    HapticFeedback.selectionClick();
    return showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          backgroundColor: cPaper,
          shape: const RoundedRectangleBorder(
              side: BorderSide(color: cInk, width: 2)),
          title: Text(section.title, style: _px(8, cInk)),
          content: SingleChildScrollView(
            child: _InfoBody(
              section.body,
              section: section.title,
              ticks: _ticks,
              onTick: (key) async {
                await _toggleTick(key);
                setDialog(() {});
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text('CLOSE', style: _px(6, cInk)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionButtons() {
    if (!_printed || _sections.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Wrap(
        alignment: WrapAlignment.center,
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final section in _sections)
            GestureDetector(
              onTap: () => _showSection(section),
              child: Container(
                constraints: const BoxConstraints(maxWidth: 170),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: cPaper,
                  border: Border.all(color: cInk, width: 2),
                ),
                child: Text(
                    '${_checkProgress(section) == null ? '' : '${_checkProgress(section)} '}'
                    '${section.title.toUpperCase()}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: _px(5, cInk, letterSpacing: 0.5, height: 1.4)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildPerforation() => Container(
    width: 260, height: 14,
    decoration: BoxDecoration(
      color: cPaper,
      border: Border(
        left:  const BorderSide(color: cPaperShadow, width: 4),
        right: const BorderSide(color: cPaperShadow, width: 4),
        top:   BorderSide(color: cPaperShadow.withValues(alpha: 0.5), width: 2),
      ),
    ),
    child: Row(children: [
      const SizedBox(width: 6),
      _perfHole(), _perfDash(), _perfHole(), _perfDash(), _perfHole(),
      const SizedBox(width: 6),
    ]),
  );

  Widget _perfHole() => Container(
    width: 8, height: 8,
    decoration: BoxDecoration(
      shape: BoxShape.circle, color: cBg,
      border: Border.all(color: cPaperShadow, width: 1),
    ),
  );

  Widget _perfDash() => Expanded(
    child: Container(height: 2,
        decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: cPaperShadow, width: 2)))),
  );

  Widget _buildTear() => CustomPaint(
    size: const Size(260, 14), painter: _TearPainter());

  Widget _moodPip() => Container(width: 6, height: 6, color: cSage);

  Widget _dashedDivider({Color color = cPaperShadow}) => SizedBox(
    height: 2,
    child: CustomPaint(
      size: const Size(double.infinity, 2),
      painter: _DashedLinePainter(color: color),
    ),
  );
}

// ── Task Row ────────────────────────────────────────────────────────────────
class _TaskRow extends StatefulWidget {
  final Task task;
  final VoidCallback onToggle;
  final VoidCallback onDelete;
  const _TaskRow({required this.task, required this.onToggle, required this.onDelete});

  @override
  State<_TaskRow> createState() => _TaskRowState();
}

class _TaskRowState extends State<_TaskRow> {
  bool _showNotes = false;

  @override
  Widget build(BuildContext context) {
    final task = widget.task;
    final dim = cInkLight.withValues(alpha: 0.6);
    final timeLabel = task.timeLabel;
    final hasNotes = task.notes != null;

    return Dismissible(
      key: ValueKey(task.id),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => widget.onDelete(),
      background: Container(
        color: cRose.withValues(alpha: 0.3),
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 12),
        child: Text('✕',
            style: GoogleFonts.pressStart2p(fontSize: 8, color: cRose)),
      ),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onToggle,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 12, height: 12,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                color: task.done ? cSage : cPaper,
                border: Border.all(
                    color: task.done ? cSage : cInk, width: 2),
              ),
              child: task.done
                  ? const Icon(Icons.check, size: 8, color: Colors.white)
                  : null,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (timeLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 3),
                      child: Text(timeLabel,
                        style: GoogleFonts.pressStart2p(
                          fontSize: 5,
                          color: task.done ? dim : tagColor(task.tag),
                          letterSpacing: 0.5,
                        ),
                      ),
                    ),
                  Text(task.label,
                    style: GoogleFonts.pressStart2p(
                      fontSize: 6,
                      color: task.done ? dim : cInk,
                      height: 1.9,
                      decoration: task.done
                          ? TextDecoration.lineThrough : TextDecoration.none,
                      decorationColor: dim,
                    ),
                  ),
                  if (hasNotes)
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => setState(() => _showNotes = !_showNotes),
                      child: Padding(
                        padding: const EdgeInsets.only(top: 3, bottom: 2),
                        child: Text(_showNotes ? '- hide how' : '+ how to start',
                          style: GoogleFonts.pressStart2p(
                              fontSize: 5, color: cInkLight, height: 1.6),
                        ),
                      ),
                    ),
                  if (hasNotes && _showNotes)
                    Container(
                      width: double.infinity,
                      margin: const EdgeInsets.only(top: 2, bottom: 2),
                      padding: const EdgeInsets.only(left: 6),
                      decoration: BoxDecoration(
                        border: Border(
                          left: BorderSide(color: tagColor(task.tag), width: 2),
                        ),
                      ),
                      child: Text(task.notes!,
                        style: GoogleFonts.pressStart2p(
                            fontSize: 5, color: cInkLight, height: 2),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              decoration: BoxDecoration(
                  border: Border.all(color: tagColor(task.tag), width: 1)),
              child: Text(task.tag.label.toUpperCase(),
                style: GoogleFonts.pressStart2p(
                    fontSize: 5, color: tagColor(task.tag), letterSpacing: 0.5),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

// ── Painters & helpers ───────────────────────────────────────────────────────
class _GridBackground extends StatefulWidget {
  const _GridBackground();
  @override
  State<_GridBackground> createState() => _GridBackgroundState();
}

class _GridBackgroundState extends State<_GridBackground> {
  final Random _rng = Random();

  double _ox = 0, _oy = 0, _angle = 12;
  double _vx = 0, _vy = 0, _va = 0;
  double _tvx = 0, _tvy = 0, _tva = 0;
  int _frameCount = 0;
  bool _running = true;

  static const double _maxSpeed = 0.25;
  static const double _maxAngleSpeed = 0.003;
  static const double _accel = 0.002;
  static const int _changeInterval = 350;

  @override
  void initState() {
    super.initState();
    _loop();
  }

  Future<void> _loop() async {
    while (_running) {
      await Future.delayed(const Duration(milliseconds: 32)); // ~30fps
      if (!mounted || !_running) break;
      setState(() {
        _frameCount++;
        if (_frameCount % _changeInterval == 0) {
          _tvx = (_rng.nextDouble() - 0.5) * 2 * _maxSpeed;
          _tvy = (_rng.nextDouble() - 0.5) * 2 * _maxSpeed;
          _tva = (_rng.nextDouble() - 0.5) * 2 * _maxAngleSpeed;
        }
        _vx += (_tvx - _vx) * _accel;
        _vy += (_tvy - _vy) * _accel;
        _va += (_tva - _va) * _accel;
        _ox += _vx;
        _oy += _vy;
        _angle = (_angle + _va).clamp(8.0, 16.0);
      });
    }
  }

  @override
  void dispose() {
    _running = false;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Positioned.fill(
        child: RepaintBoundary(
          child: CustomPaint(
            painter: _GridPainter(ox: _ox, oy: _oy, angle: _angle),
          ),
        ),
      );
}
class _GridPainter extends CustomPainter {
  final double ox, oy, angle;
  const _GridPainter({required this.ox, required this.oy, required this.angle});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.black.withValues(alpha: 0.055)
      ..strokeWidth = 1;
    canvas.save();
    final cx = size.width / 2;
    final cy = size.height / 2;
    canvas.translate(cx + ox, cy + oy);
    canvas.rotate(angle * pi / 180);
    canvas.translate(-cx * 2, -cy * 2);
    for (double x = 0; x < size.width * 4; x += 32) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height * 4), paint);
    }
    for (double y = 0; y < size.height * 4; y += 32) {
      canvas.drawLine(Offset(0, y), Offset(size.width * 4, y), paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GridPainter old) =>
      old.ox != ox || old.oy != oy || old.angle != angle;
}

class _ScanLinesPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Colors.black.withValues(alpha: 0.018);
    for (double y = 7; y < size.height; y += 8) {
      canvas.drawRect(Rect.fromLTWH(0, y, size.width, 1), p);
    }
  }
  @override bool shouldRepaint(_) => false;
}

class _TearPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path();
    const segs = 25;
    final segW = size.width / segs;
    path.moveTo(0, 0);
    for (int i = 0; i <= segs; i++) {
      path.lineTo(i * segW, i.isEven ? size.height : 0);
    }
    path.lineTo(size.width, 0);
    path.close();
    canvas.drawPath(path, Paint()..color = cPaper);
    canvas.drawRect(Rect.fromLTWH(0, 0, 4, size.height),
        Paint()..color = cPaperShadow);
    canvas.drawRect(Rect.fromLTWH(size.width - 4, 0, 4, size.height),
        Paint()..color = cPaperShadow);
  }
  @override bool shouldRepaint(_) => false;
}

class _DashedLinePainter extends CustomPainter {
  final Color color;
  const _DashedLinePainter({required this.color});
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color..strokeWidth = 2;
    double x = 0;
    while (x < size.width) {
      canvas.drawLine(Offset(x, 1), Offset(x + 6, 1), p);
      x += 10;
    }
  }
  @override bool shouldRepaint(_DashedLinePainter o) => o.color != color;
}

class _DecoScene extends StatelessWidget {
  const _DecoScene();
  @override
  Widget build(BuildContext context) {
    final decos = [
      const _D('☕', 0.02, 0.38, -14, 1.1),  const _D('🌵', 0.05, 0.65, 8,   0.95),
      const _D('🕯️', 0.78, 0.30, 12,  1.0),  const _D('🍪', 0.82, 0.60, -9,  1.05),
      const _D('📓', 0.06, 0.82, -18, 0.9),  const _D('🌿', 0.80, 0.80, 22,  1.1),
      const _D('⭐', 0.88, 0.12, -5,  0.8),  const _D('🍵', 0.01, 0.14, 10,  0.85),
    ];
    return Positioned.fill(
      child: IgnorePointer(
        child: Stack(
          children: decos.map((d) => Positioned(
            left: MediaQuery.of(context).size.width * d.l,
            top:  MediaQuery.of(context).size.height * d.t,
            child: Transform.rotate(
              angle: d.r * pi / 180,
              child: Transform.scale(scale: d.s,
                child: Text(d.e, style: TextStyle(fontSize: 22 * d.s,
                    shadows: const [Shadow(offset: Offset(1,2),
                        blurRadius: 2, color: Color(0x30000000))]))),
            ),
          )).toList(),
        ),
      ),
    );
  }
}

class _D {
  final String e; final double l, t, r, s;
  const _D(this.e, this.l, this.t, this.r, this.s);
}