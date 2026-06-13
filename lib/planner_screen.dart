import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'dart:math';
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
const Color cBg          = Color(0xFFC8B89A);
const Color cBgDark      = Color(0xFFA8966E);

Color tagColor(TaskTag tag) {
  switch (tag) {
    case TaskTag.cozy:
    case TaskTag.social: return cRose;
    case TaskTag.nature:
    case TaskTag.wild:   return cSage;
    case TaskTag.work:
    case TaskTag.home:
    case TaskTag.gold:   return cAmber;
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

  List<Task> _tasks = [];

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

    // Try silent sign-in on launch
    _trySilentSignIn();
  }

  Future<void> _trySilentSignIn() async {
    final ok = await TasksService.signIn();
    if (ok && mounted) setState(() {});
  }

  @override
  void dispose() {
    _lightController.dispose();
    _feedController.dispose();
    super.dispose();
  }

  int get _doneCount => _tasks.where((t) => t.done).length;

  String get _progressMessage {
    final total = _tasks.length;
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
    final now    = DateTime.now();
    return '${days[now.weekday % 7]}, ${months[now.month - 1]} ${now.day}';
  }

  Future<void> _toggleTask(Task task) async {
    HapticFeedback.lightImpact();
    final newDone = !task.done;
    setState(() => task.done = newDone);

    final ok = await TasksService.setTaskCompleted(task, newDone);
    if (!ok && mounted) {
      // Couldn't reach Google Tasks — revert the checkbox so the UI
      // doesn't claim it's synced when it isn't.
      setState(() {
        task.done = !newDone;
        _error = "Couldn't sync with Google Tasks";
      });
    }
  }

  void _deleteTask(Task task) {
    HapticFeedback.mediumImpact();
    setState(() => _tasks.remove(task));
  }

  Future<void> _handleSignOut() async {
    await TasksService.signOut();
    if (mounted) setState(() { _tasks = []; _printed = false; });
  }

  Future<void> _printPaper() async {
    if (!TasksService.isSignedIn) {
      setState(() => _error = null);
      final ok = await TasksService.signIn();
      if (!ok) {
        if (mounted) setState(() => _error = 'Sign in failed. Try again.');
        return;
      }
      if (mounted) setState(() {});
    }

    HapticFeedback.mediumImpact();
    setState(() { _loading = true; _error = null; });

    final tasks = await TasksService.fetchTasks();

    if (!mounted) return;
    setState(() {
      _loading = false;
      _tasks   = tasks;
      _printed = true;
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
                  color: const Color(0xFF4A3728).withOpacity(0.55),
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: GestureDetector(
                  // Long-press the printer to sign out — keeps the UI
                  // free of a persistent email/sign-out line.
                  onLongPress: TasksService.isSignedIn ? _handleSignOut : null,
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
                        TasksService.isSignedIn
                            ? 'hit print to\nfetch your tasks'
                            : 'sign in to load\nyour google tasks',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.pressStart2p(
                          fontSize: 6,
                          color: const Color(0xFF4A3728).withOpacity(0.4),
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
                        !TasksService.isSignedIn
                            ? '[ SIGN IN & PRINT ]'
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
    final total = _tasks.length;
    final done  = _doneCount;

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
                  Text('Vibe: cozy & capable',
                      style: GoogleFonts.pressStart2p(
                          fontSize: 5, color: cInkLight, letterSpacing: 0.5)),
                  const SizedBox(width: 6), _moodPip(),
                ]),
                const SizedBox(height: 10),
                _dashedDivider(),
                const SizedBox(height: 14),

                // Tasks
                if (_tasks.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                      'no tasks found!\nenjoy the free time ✦',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.pressStart2p(
                          fontSize: 6, color: cInkLight, height: 2),
                    ),
                  )
                else
                  Column(
                    children: _tasks.map((t) => _TaskRow(
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
                if (_tasks.isNotEmpty) ...[
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
              ]),
            ),
          ]),
        ),
        _buildTear(),
        Center(
          child: Container(
            width: 234, height: 8,
            decoration: BoxDecoration(
              color: Colors.black.withOpacity(0.12),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _buildPerforation() => Container(
    width: 260, height: 14,
    decoration: BoxDecoration(
      color: cPaper,
      border: Border(
        left:  const BorderSide(color: cPaperShadow, width: 4),
        right: const BorderSide(color: cPaperShadow, width: 4),
        top:   BorderSide(color: cPaperShadow.withOpacity(0.5), width: 2),
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
class _TaskRow extends StatelessWidget {
  final Task task;
  final VoidCallback onToggle;
  final VoidCallback onDelete;
  const _TaskRow({required this.task, required this.onToggle, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    return Dismissible(
      key: ValueKey(task.id),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onDelete(),
      background: Container(
        color: cRose.withOpacity(0.3),
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 12),
        child: Text('✕',
            style: GoogleFonts.pressStart2p(fontSize: 8, color: cRose)),
      ),
      child: GestureDetector(
        onTap: onToggle,
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
              child: Text(task.label,
                style: GoogleFonts.pressStart2p(
                  fontSize: 6,
                  color: task.done ? cInkLight.withOpacity(0.6) : cInk,
                  height: 1.9,
                  decoration: task.done
                      ? TextDecoration.lineThrough : TextDecoration.none,
                  decorationColor: cInkLight.withOpacity(0.6),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              decoration: BoxDecoration(
                  border: Border.all(color: tagColor(task.tag), width: 1)),
              child: Text(task.tag.name.toUpperCase(),
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
class _GridBackground extends StatelessWidget {
  const _GridBackground();
  @override
  Widget build(BuildContext context) =>
      Positioned.fill(child: CustomPaint(painter: _GridPainter()));
}

class _GridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.black.withOpacity(0.055)..strokeWidth = 1;
    canvas.save();
    final cx = size.width / 2; final cy = size.height / 2;
    canvas.translate(cx, cy);
    canvas.rotate(12 * pi / 180);
    canvas.translate(-cx * 2, -cy * 2);
    for (double x = 0; x < size.width * 4; x += 32)
      canvas.drawLine(Offset(x, 0), Offset(x, size.height * 4), paint);
    for (double y = 0; y < size.height * 4; y += 32)
      canvas.drawLine(Offset(0, y), Offset(size.width * 4, y), paint);
    canvas.restore();
  }
  @override bool shouldRepaint(_) => false;
}

class _ScanLinesPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Colors.black.withOpacity(0.018);
    for (double y = 7; y < size.height; y += 8)
      canvas.drawRect(Rect.fromLTWH(0, y, size.width, 1), p);
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
    for (int i = 0; i <= segs; i++)
      path.lineTo(i * segW, i.isEven ? size.height : 0);
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
      _D('☕', 0.02, 0.38, -14, 1.1),  _D('🌵', 0.05, 0.65, 8,   0.95),
      _D('🕯️', 0.78, 0.30, 12,  1.0),  _D('🍪', 0.82, 0.60, -9,  1.05),
      _D('📓', 0.06, 0.82, -18, 0.9),  _D('🌿', 0.80, 0.80, 22,  1.1),
      _D('⭐', 0.88, 0.12, -5,  0.8),  _D('🍵', 0.01, 0.14, 10,  0.85),
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