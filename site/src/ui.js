// The planner website's screen. It runs inside the unlocked page, after logic.mjs (inlined above it by build.mjs), so
// everything exported there is a plain global here. All task rules come from logic.mjs; this file only draws and wires.
// The look follows the phone app: drifting grid, a pixel-art printer with blinking lights, a receipt that feeds out of it.

(function () {
  var cfg = window.__CFG;
  var api = createApi({ baseUrl: cfg.url, token: cfg.token, fetchImpl: function (u, i) { return fetch(u, i); } });

  var state = {
    date: null,
    tasks: [],
    headline: null,
    sections: [],
    rating: null,
    plan: 'A',
    error: null,
    loaded: false,
    loading: false,
    printed: false,
    notesOpen: {},
    sheet: null,
    ticks: {},
  };
  var pending = {}; // task id -> number of changes still on their way to the server
  var queues = {}; // task id -> promise chain, so rapid taps reach the server in order
  var holding = false; // a flag is being held: don't redraw under the finger
  var feed = null; // the paper wrapper once it exists

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }

  function svg(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) el.appendChild(arguments[i]);
    return el;
  }

  var $ = function (id) { return document.getElementById(id); };

  function dateLabel() {
    if (!state.date) return '';
    var p = state.date.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  // ---- the scenery: zoom, drifting grid, scattered decorations, the printer ----
  function setZoom() {
    var z = Math.max(1.2, Math.min(1.7, window.innerWidth / 300));
    document.documentElement.style.setProperty('--z', String(z));
  }

  function startGrid() {
    var canvas = $('grid');
    var ctx = canvas.getContext('2d');
    var ox = 0, oy = 0, angle = 12, vx = 0, vy = 0, va = 0, tvx = 0, tvy = 0, tva = 0, frame = 0;
    var last = 0;
    function resize() {
      var r = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * r);
      canvas.height = Math.floor(window.innerHeight * r);
      ctx.setTransform(r, 0, 0, r, 0, 0);
    }
    function tickGrid(t) {
      requestAnimationFrame(tickGrid);
      if (t - last < 32) return;
      last = t;
      frame++;
      if (frame % 350 === 0) {
        tvx = (Math.random() - 0.5) * 2 * 0.25;
        tvy = (Math.random() - 0.5) * 2 * 0.25;
        tva = (Math.random() - 0.5) * 2 * 0.003;
      }
      vx += (tvx - vx) * 0.002; vy += (tvy - vy) * 0.002; va += (tva - va) * 0.002;
      ox += vx; oy += vy;
      angle = Math.max(8, Math.min(16, angle + va));
      var w = window.innerWidth, hgt = window.innerHeight;
      ctx.fillStyle = '#C8B89A';
      ctx.fillRect(0, 0, w, hgt);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.055)';
      ctx.lineWidth = 1;
      ctx.translate(w / 2 + ox, hgt / 2 + oy);
      ctx.rotate(angle * Math.PI / 180);
      ctx.translate(-w, -hgt);
      ctx.beginPath();
      for (var x = 0; x < w * 4; x += 32) { ctx.moveTo(x, 0); ctx.lineTo(x, hgt * 4); }
      for (var y = 0; y < hgt * 4; y += 32) { ctx.moveTo(0, y); ctx.lineTo(w * 4, y); }
      ctx.stroke();
      ctx.restore();
    }
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(tickGrid);
  }

  function addDecorations() {
    var decos = [
      ['☕', 0.02, 0.38, -14, 1.1], ['🌵', 0.05, 0.65, 8, 0.95],
      ['🕯️', 0.78, 0.30, 12, 1.0], ['🍪', 0.82, 0.60, -9, 1.05],
      ['📓', 0.06, 0.82, -18, 0.9], ['🌿', 0.80, 0.80, 22, 1.1],
      ['⭐', 0.88, 0.12, -5, 0.8], ['🍵', 0.01, 0.14, 10, 0.85],
    ];
    var box = $('deco');
    decos.forEach(function (d) {
      var s = h('span', { style: 'left:' + d[1] * 100 + '%;top:' + d[2] * 100 + '%;font-size:' + 22 * d[4] + 'px;transform:rotate(' + d[3] + 'deg)' }, d[0]);
      box.appendChild(s);
    });
  }

  // ---- checklist ticks inside info sections (kept on this device, per day) ----
  function ticksKey() { return 'planner-ticks-' + state.date; }
  function loadTicks() {
    try { state.ticks = JSON.parse(localStorage.getItem(ticksKey()) || '{}') || {}; } catch (e) { state.ticks = {}; }
  }
  function saveTicks() {
    try { localStorage.setItem(ticksKey(), JSON.stringify(state.ticks)); } catch (e) { /* storage may be blocked */ }
  }

  function vibe() {
    var list = window.__VIBES || [];
    var today = new Date().toDateString();
    try {
      var saved = JSON.parse(localStorage.getItem('planner-vibe') || 'null');
      if (saved && saved.d === today) return saved.t;
    } catch (e) { /* ignore */ }
    var pick = list.length ? list[Math.floor(Math.random() * list.length)] : 'Matthew 11:29';
    try { localStorage.setItem('planner-vibe', JSON.stringify({ d: today, t: pick })); } catch (e) { /* ignore */ }
    return pick;
  }
  var todaysVibe = vibe();

  // ---- talking to the server ----
  function touch(id, delta) {
    pending[id] = (pending[id] || 0) + delta;
    if (pending[id] <= 0) delete pending[id];
  }

  function pendingIds() { return new Set(Object.keys(pending)); }

  /** Applies a change on screen at once, sends it, and puts the old value back if the server refused it. */
  function act(id, mutate, send) {
    var idx = state.tasks.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var before = state.tasks[idx];
    var next = mutate(before);
    if (next === before) return;
    state.tasks[idx] = next;
    touch(id, 1);
    render();
    queues[id] = (queues[id] || Promise.resolve()).then(function () {
      return send(next).then(function (ok) {
        touch(id, -1);
        if (!ok) {
          var i = state.tasks.findIndex(function (t) { return t.id === id; });
          if (i >= 0 && state.tasks[i] === next) state.tasks[i] = before;
          state.error = "Couldn't sync that change";
        }
        render();
      });
    });
  }

  /** Fetches today's plan. `print` feeds the paper out of the printer (the first load and the REPRINT button). */
  function refresh(print) {
    if (holding) return Promise.resolve();
    if (print) { state.loading = true; state.error = null; render(); }
    return api.getDay().then(function (day) {
      var dateChanged = state.date !== day.date;
      state.date = day.date;
      if (dateChanged) loadTicks();
      state.tasks = mergeServerDay(state.tasks, day.tasks, pendingIds());
      state.headline = day.headline;
      state.sections = day.sections;
      if (!pending.rating) state.rating = day.rating;
      state.plan = choosePlan(state.tasks, state.plan);
      state.error = null;
      state.loaded = true;
      state.loading = false;
      var firstPrint = !state.printed;
      state.printed = true;
      render();
      if (print || firstPrint) feedPaper();
    }).catch(function (e) {
      state.loading = false;
      state.error = e && e.message ? e.message : "can't reach server";
      render();
    });
  }

  function setRating(n) {
    var before = state.rating;
    var next = before === n ? null : n;
    state.rating = next;
    pending.rating = (pending.rating || 0) + 1;
    render();
    api.setRating(next).then(function (ok) {
      pending.rating -= 1;
      if (pending.rating <= 0) delete pending.rating;
      if (!ok) { state.rating = before; state.error = "Couldn't sync that change"; }
      render();
    });
  }

  // ---- drawing the receipt ----
  function planTasks() { return state.tasks.filter(function (t) { return t.plan === state.plan; }); }
  function hasPlanB() { return state.tasks.some(function (t) { return t.plan === 'B'; }); }
  function dash(dark, tight) { return h('div', { class: 'dash' + (dark ? ' dark' : '') + (tight ? ' tight' : '') }); }

  function planChip(p) {
    var starts = state.tasks.filter(function (t) { return t.plan === p && t.start; }).map(function (t) { return t.start; }).sort();
    var label = 'PLAN ' + p + (starts.length ? '\n' + formatClock(starts[0]) : '');
    return h('button', { class: 'chip' + (state.plan === p ? ' on' : ''), onclick: function () { state.plan = p; render(); } }, label);
  }

  function flagButton(task) {
    var timer = null;
    var flagIcon = svg('svg', { viewBox: '0 0 24 24' }, svg('path', { d: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z' }));
    var btn = h('button', { class: 'flagbtn' + (task.flagged ? ' on' : ''), 'aria-label': task.flagged ? 'Hold to clear flag' : 'Hold 2 seconds to flag' },
      svg('svg', { viewBox: '0 0 28 28' }, svg('circle', { class: 'ring', cx: '14', cy: '14', r: '11' })),
      h('span', { class: 'f' }, flagIcon));
    function start(e) {
      e.preventDefault();
      e.stopPropagation();
      if (timer) return;
      holding = true;
      btn.classList.add('holding');
      timer = setTimeout(function () {
        timer = null;
        holding = false;
        if (navigator.vibrate) navigator.vibrate(60);
        act(task.id, toggleFlag, function (t) { return api.setFlagged(t.id, t.flagged); });
      }, HOLD_FLAG_MS);
    }
    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      holding = false;
      btn.classList.remove('holding');
    }
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('click', function (e) { e.stopPropagation(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    return btn;
  }

  function taskRow(task) {
    var color = TAG_COLOR[task.tag];
    var ph = phase(task);
    var label = timeLabel(task);
    var open = !!state.notesOpen[task.id];

    var ctl = null;
    if (ph === 'done') {
      var s = startedLabel(task);
      if (s) ctl = h('div', { class: 'startedtxt' }, 'started ' + s);
    } else {
      ctl = h('div', { class: 'ctl' },
        h('button', {
          class: 'go' + (ph === 'running' ? ' fin' : ''),
          style: 'border-color:' + color + ';' + (ph === 'running' ? 'background:' + color : 'color:' + color),
          onclick: function (e) {
            e.stopPropagation();
            if (ph === 'running') act(task.id, tick, function (t) { return api.setDone(t.id, true); });
            else act(task.id, function (t) { return pressStart(t, new Date().toISOString()); }, function () { return api.setStarted(task.id, true); });
          },
        }, ph === 'running' ? 'FINISH' : 'START'),
        ph === 'running' ? h('span', { class: 'startedtxt' }, 'since ' + startedLabel(task)) : null);
    }

    var stopBtn = canStop(task)
      ? h('button', {
          class: 'stop',
          'aria-label': 'Reset start',
          onclick: function (e) { e.stopPropagation(); act(task.id, pressStop, function () { return api.setStarted(task.id, false); }); },
        }, h('i'))
      : null;

    return h('div', {
      class: 'row' + (task.done ? ' done' : '') + (task.flagged ? ' flagged' : ''),
      onclick: function () { act(task.id, toggleDone, function (t) { return api.setDone(t.id, t.done); }); },
    },
      h('div', { class: 'box' }, task.done ? '✓' : ''),
      h('div', { class: 'body' },
        label ? h('div', { class: 'time', style: 'color:' + (task.done ? 'rgba(92,61,30,.6)' : color) }, label) : null,
        h('div', { class: 'title' }, task.title),
        task.flagged ? h('div', { class: 'flaglabel' }, 'FLAGGED: times ignored') : null,
        ctl,
        task.notes ? h('button', { class: 'how', onclick: function (e) { e.stopPropagation(); state.notesOpen[task.id] = !open; render(); } }, open ? '- hide how' : '+ how to start') : null,
        task.notes && open ? h('div', { class: 'notes', style: 'border-color:' + color }, task.notes) : null),
      h('div', { class: 'side' },
        h('span', { class: 'tag', style: 'color:' + color + ';border-color:' + color }, TAG_LABEL[task.tag]),
        h('div', { class: 'flagcol' }, flagButton(task), stopBtn)));
  }

  function receiptContent() {
    var tasks = planTasks();
    var total = tasks.length;
    var done = tasks.filter(function (t) { return t.done; }).length;
    var msg = progressMessage(done, total);
    var kids = [
      h('p', { class: 'h1' }, "Today's Tasks"),
      h('div', { class: 'leaf' }, '🌿 ☕ 🌿'),
      h('p', { class: 'date' }, dateLabel()),
      dash(true),
      h('div', { class: 'mood' }, h('i'), h('span', {}, todaysVibe), h('i')),
      dash(false, true),
    ];
    if (state.headline) kids.push(h('p', { class: 'headline' }, state.headline), dash(false, true));
    if (hasPlanB()) kids.push(h('div', { class: 'chips' }, planChip('A'), planChip('B')));
    if (tasks.length === 0) {
      kids.push(h('div', { class: 'empty' }, hasPlanB() ? 'nothing in plan ' + state.plan : 'no tasks found!\nenjoy the free time ✦'));
      return kids;
    }
    tasks.forEach(function (t) { kids.push(taskRow(t)); });
    kids.push(dash(false, true));
    kids.push(h('div', { class: 'progress-h' }, h('span', {}, 'PROGRESS'), h('span', {}, done + ' / ' + total)));
    var bars = h('div', { class: 'bars' });
    for (var i = 0; i < total; i++) bars.appendChild(h('i', { class: i < done ? 'on' : '' }));
    kids.push(bars);
    if (msg) kids.push(h('div', { class: 'msg' }, msg));
    kids.push(dash(false, true));
    var nums = h('div', { class: 'nums' });
    [1, 2, 3, 4, 5].forEach(function (n) {
      nums.appendChild(h('button', { class: state.rating === n ? 'on' : '', onclick: function () { setRating(n); } }, String(n)));
    });
    kids.push(h('div', { class: 'rate' },
      h('h3', {}, 'HOW DID TODAY FEEL?'),
      nums,
      h('div', { class: 'ends' }, h('span', {}, 'drained'), h('span', {}, 'good'))));
    kids.push(h('div', { class: 'hint' }, 'forgot to start or finish on time?\nhold the flag 2 seconds'));
    return kids;
  }

  /** "2/4" for a section that has checklist items, else ''. */
  function checkProgress(sec) {
    var items = parseSectionBody(sec.body).filter(function (l) { return l.kind === 'check'; });
    if (!items.length) return '';
    var n = items.filter(function (l) { return state.ticks[sec.title + '|' + l.text]; }).length;
    return n + '/' + items.length + ' ';
  }

  function dialog() {
    var sec = state.sheet;
    if (!sec) return null;
    function close() { state.sheet = null; render(); }
    var lines = parseSectionBody(sec.body).map(function (l) {
      if (l.kind === 'text') return l.text.trim() === '' ? null : h('p', {}, l.text);
      var key = sec.title + '|' + l.text;
      var on = !!state.ticks[key];
      return h('div', { class: 'check' + (on ? ' on' : ''), onclick: function () { if (on) delete state.ticks[key]; else state.ticks[key] = 1; saveTicks(); render(); } },
        h('span', { class: 'box', style: on ? 'background:var(--sage);border-color:var(--sage)' : '' }, on ? '✓' : ''),
        h('span', {}, l.text));
    });
    return h('div', { class: 'modal', onclick: function (e) { if (e.target === e.currentTarget) close(); } },
      h('div', { class: 'dialog' }, h('h2', {}, sec.title), lines, h('div', { class: 'actions' }, h('button', { class: 'close', onclick: close }, 'CLOSE'))));
  }

  var receipt = null; // the receipt element once the paper exists

  function ensurePaper() {
    if (receipt) return;
    receipt = h('div', { class: 'receipt' });
    var inner = h('div', { class: 'sheet-in' },
      h('div', { class: 'perf' }, h('i'), h('b'), h('i'), h('b'), h('i')),
      receipt,
      h('div', { class: 'tear' }),
      h('div', { class: 'shadowbar' }));
    feed = h('div', { class: 'feed done' }, inner);
    var zone = $('paperzone');
    zone.replaceChildren(feed);
  }

  /** The receipt feeds down out of the printer: its bottom shows first and the rest follows, like a real printer. */
  function feedPaper() {
    ensurePaper();
    var inner = feed.firstChild;
    feed.classList.remove('done');
    feed.style.transition = 'none';
    feed.style.height = '0px';
    void feed.offsetHeight;
    var full = inner.offsetHeight;
    feed.style.transition = 'height 4s cubic-bezier(0, 0, 0.2, 1)';
    feed.style.height = full + 'px';
    var finished = false;
    function end() {
      if (finished) return;
      finished = true;
      feed.style.transition = 'none';
      feed.style.height = 'auto';
      feed.classList.add('done');
    }
    feed.addEventListener('transitionend', end, { once: true });
    setTimeout(end, 4300);
  }

  function render() {
    // paper
    if (!state.printed) {
      var zone = $('paperzone');
      if (!zone.firstChild || zone.firstChild.className !== 'hello') {
        zone.replaceChildren(h('div', { class: 'hello' }, state.error ? '' : 'fetching your tasks...'));
      }
    } else {
      ensurePaper();
      receipt.replaceChildren.apply(receipt, receiptContent());
    }

    // bottom bar: error, info buttons, print
    var bar = [];
    if (state.error) bar.push(h('div', { class: 'err' }, state.error));
    if (state.printed && state.sections.length) {
      bar.push(h('div', { class: 'secs' }, state.sections.map(function (s) {
        return h('button', { class: 'sec', onclick: function () { state.sheet = s; render(); } }, checkProgress(s) + s.title);
      })));
    }
    bar.push(state.loading
      ? h('div', { class: 'fetching' }, 'fetching tasks...')
      : h('button', { class: 'printbtn', onclick: function () { refresh(true); } }, state.printed ? '[ REPRINT ]' : '[ PRINT ]'));
    var barEl = $('bar');
    barEl.replaceChildren.apply(barEl, bar);

    // dialog
    var old = document.querySelector('.modal');
    if (old) old.remove();
    var d = dialog();
    if (d) document.body.appendChild(d);
  }

  // ---- go ----
  setZoom();
  window.addEventListener('resize', setZoom);
  startGrid();
  addDecorations();
  startPrinter($('printer'));
  $('lock').addEventListener('click', function () { location.reload(); });
  render();
  refresh(true);

  // keep it in sync all the time: every 20 seconds, and whenever you come back to the tab
  setInterval(function () {
    if (document.visibilityState === 'visible') refresh(false);
  }, 20000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(false); });
  window.addEventListener('focus', function () { refresh(false); });
  window.addEventListener('online', function () { refresh(false); });
})();
