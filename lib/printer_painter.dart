import 'package:flutter/material.dart';

/// Paints the pixel-art printer faithful to the HTML canvas version.
class PrinterPainter extends CustomPainter {
  final double blinkPhase; // 0.0–1.0 drives light animations

  PrinterPainter({required this.blinkPhase});

  static const double P = 4.0; // pixel size

  static const Color darkest    = Color(0xFF1a0d00);
  static const Color dark       = Color(0xFF2e1a08);
  static const Color body       = Color(0xFF4A3728);
  static const Color mid        = Color(0xFF5a4030);
  static const Color base       = Color(0xFF6B5040);
  static const Color warm       = Color(0xFF7a5c44);
  static const Color light      = Color(0xFF8C6B52);
  static const Color lighter    = Color(0xFFa07858);
  static const Color tan        = Color(0xFFb89070);
  static const Color hilight    = Color(0xFFc4a078);
  static const Color slotColor  = Color(0xFF0d0600);
  static const Color paperPeek  = Color(0xFFFFF8EE); // matches cPaper
  static const Color rose       = Color(0xFFE8A0A0);
  static const Color rosehi     = Color(0xFFf0c0c0);
  static const Color rosedark   = Color(0xFFa06060);
  static const Color sage       = Color(0xFF8BAF7C);
  static const Color amber      = Color(0xFFD4A843);
  static const Color redLight   = Color(0xFFc97a7a);

  void px(Canvas canvas, int x, int y, Color color, {int w = 1, int h = 1}) {
    canvas.drawRect(
      Rect.fromLTWH(x * P, y * P, w * P, h * P),
      Paint()..color = color,
    );
  }

  @override
  void paint(Canvas canvas, Size size) {
    // Body fill
    canvas.drawRect(
      const Rect.fromLTWH(0, 4 * P, 80 * P, 20 * P),
      Paint()..color = base,
    );

    // Top strip highlight
    canvas.drawRect(const Rect.fromLTWH(0, 0, 80 * P, 3 * P), Paint()..color = light);
    canvas.drawRect(const Rect.fromLTWH(0, 3 * P, 80 * P, P), Paint()..color = body);

    // Edge highlights
    for (int row = 0; row < 24; row++) {
      px(canvas, 0, row, row < 4 ? tan : light);
      px(canvas, 79, row, dark);
    }

    // Bottom feet
    for (int col = 5; col < 75; col++) {
      px(canvas, col, 23, dark);
      px(canvas, col, 24, darkest);
      px(canvas, col, 25, darkest);
    }
    for (int col = 5; col < 18; col++) {
      px(canvas, col, 24, body);
      px(canvas, col, 25, dark);
      px(canvas, col, 26, darkest);
    }
    for (int col = 62; col < 75; col++) {
      px(canvas, col, 24, body);
      px(canvas, col, 25, dark);
      px(canvas, col, 26, darkest);
    }

    // Paper slot — dark opening with a sliver of paper visible inside,
    // so it visually connects to the paper feeding out below.
    for (int col = 24; col < 56; col++) {
      px(canvas, col, 20, slotColor);
      px(canvas, col, 21, paperPeek);
      px(canvas, col, 22, dark);
    }
    px(canvas, 23, 20, dark); px(canvas, 56, 20, dark);
    px(canvas, 23, 21, dark); px(canvas, 56, 21, dark);

    // Rose button
    for (int bx = 6; bx < 13; bx++) {
      for (int by = 7; by < 11; by++) {
        Color shade = rose;
        if (bx == 6 || by == 7) shade = rosehi;
        if (bx == 12 || by == 10) shade = rosedark;
        px(canvas, bx, by, shade);
      }
    }

    // Vents
    for (int v = 0; v < 3; v++) {
      final vy = 7 + v * 3;
      for (int col = 16; col < 26; col++) {
        px(canvas, col, vy, dark);
        px(canvas, col, vy + 1, body);
      }
    }

    // Animated lights
    final int frame = (blinkPhase * 100).toInt();

    // Green: slow pulse (62-frame cycle, on for 55)
    final bool greenOn = (frame % 62) < 55;
    for (int lx = 66; lx < 68; lx++) {
      for (int ly = 7; ly < 9; ly++) {
        px(canvas, lx, ly, greenOn ? sage : body);
      }
    }
    px(canvas, 65, 7, dark); px(canvas, 68, 7, dark);
    px(canvas, 66, 6, dark); px(canvas, 66, 9, dark);
    px(canvas, 67, 6, dark); px(canvas, 67, 9, dark);

    // Amber: fast blink (36-frame cycle, on for 18)
    final bool amberOn = (frame % 36) < 18;
    for (int lx = 69; lx < 71; lx++) {
      for (int ly = 7; ly < 9; ly++) {
        px(canvas, lx, ly, amberOn ? amber : body);
      }
    }
    px(canvas, 68, 7, dark); px(canvas, 71, 7, dark);
    px(canvas, 69, 6, dark); px(canvas, 69, 9, dark);
    px(canvas, 70, 6, dark); px(canvas, 70, 9, dark);

    // Red light (always off for ambiance)
    for (int lx = 72; lx < 74; lx++) {
      for (int ly = 7; ly < 9; ly++) {
        px(canvas, lx, ly, redLight);
      }
    }
    px(canvas, 71, 7, dark); px(canvas, 74, 7, dark);
    px(canvas, 72, 6, dark); px(canvas, 72, 9, dark);
    px(canvas, 73, 6, dark); px(canvas, 73, 9, dark);
  }

  @override
  bool shouldRepaint(PrinterPainter old) => old.blinkPhase != blinkPhase;
}
