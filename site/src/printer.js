// Port of lib/printer_painter.dart: an 80 x 27 pixel-art printer, four canvas pixels per printer pixel, with blinking lights.
// Shared by the locked search page and the planner (build.mjs inlines it into both), so it uses no imports or modules.

function startPrinter(canvas) {
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var P = 4;
  var C = { darkest: '#1a0d00', dark: '#2e1a08', body: '#4A3728', base: '#6B5040', light: '#8C6B52', tan: '#b89070', slot: '#0d0600', paper: '#FFF8EE', rose: '#E8A0A0', rosehi: '#f0c0c0', rosedark: '#a06060', sage: '#8BAF7C', amber: '#D4A843', red: '#c97a7a' };
  function px(x, y, color, w, hh) { ctx.fillStyle = color; ctx.fillRect(x * P, y * P, (w || 1) * P, (hh || 1) * P); }
  function draw(phase) {
    ctx.clearRect(0, 0, 320, 108);
    px(0, 4, C.base, 80, 20);
    px(0, 0, C.light, 80, 3);
    px(0, 3, C.body, 80, 1);
    var row, col;
    for (row = 0; row < 24; row++) { px(0, row, row < 4 ? C.tan : C.light); px(79, row, C.dark); }
    for (col = 5; col < 75; col++) { px(col, 23, C.dark); px(col, 24, C.darkest); px(col, 25, C.darkest); }
    for (col = 5; col < 18; col++) { px(col, 24, C.body); px(col, 25, C.dark); px(col, 26, C.darkest); }
    for (col = 62; col < 75; col++) { px(col, 24, C.body); px(col, 25, C.dark); px(col, 26, C.darkest); }
    for (col = 24; col < 56; col++) { px(col, 20, C.slot); px(col, 21, C.paper); px(col, 22, C.dark); }
    px(23, 20, C.dark); px(56, 20, C.dark); px(23, 21, C.dark); px(56, 21, C.dark);
    var bx, by;
    for (bx = 6; bx < 13; bx++) {
      for (by = 7; by < 11; by++) {
        var shade = C.rose;
        if (bx === 6 || by === 7) shade = C.rosehi;
        if (bx === 12 || by === 10) shade = C.rosedark;
        px(bx, by, shade);
      }
    }
    for (var v = 0; v < 3; v++) {
      var vy = 7 + v * 3;
      for (col = 16; col < 26; col++) { px(col, vy, C.dark); px(col, vy + 1, C.body); }
    }
    var f = Math.floor(phase * 100);
    var greenOn = (f % 62) < 55;
    var amberOn = (f % 36) < 18;
    var lx, ly;
    for (lx = 66; lx < 68; lx++) for (ly = 7; ly < 9; ly++) px(lx, ly, greenOn ? C.sage : C.body);
    [[65, 7], [68, 7], [66, 6], [66, 9], [67, 6], [67, 9]].forEach(function (p) { px(p[0], p[1], C.dark); });
    for (lx = 69; lx < 71; lx++) for (ly = 7; ly < 9; ly++) px(lx, ly, amberOn ? C.amber : C.body);
    [[68, 7], [71, 7], [69, 6], [69, 9], [70, 6], [70, 9]].forEach(function (p) { px(p[0], p[1], C.dark); });
    for (lx = 72; lx < 74; lx++) for (ly = 7; ly < 9; ly++) px(lx, ly, C.red);
    [[71, 7], [74, 7], [72, 6], [72, 9], [73, 6], [73, 9]].forEach(function (p) { px(p[0], p[1], C.dark); });
  }
  draw(0);
  if (typeof requestAnimationFrame !== 'function') return;
  var start = performance.now();
  (function loop(t) {
    requestAnimationFrame(loop);
    draw(((t - start) % 4000) / 4000);
  })(start);
}
