// The planner website's screen: three trays (To do, Current, Done) of paper slips. It runs inside the unlocked page, after
// logic.mjs and printer.js (inlined above it by build.mjs), so everything they define is a plain global here.
// All the rules (which tray a task is in, what a drop does, what is next) live in logic.mjs; this file only draws and wires.

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
    expanded: {}, // slips opened by tapping (To do and Done); Current slips are always open
    focus: [], // ids pulled into Current but not started, in the order they were pulled (kept on this device)
    sheet: null,
    ticks: {},
  };
  var pending = {}; // task id -> number of changes still on their way to the server
  var queues = {}; // task id -> promise chain, so rapid taps reach the server in order
  var holding = false; // a flag is being held: don't redraw under the finger
  var drag = null; // a slip is being dragged
  var scale = 1.3;
  var errTimer = null;
  var popId = null; // the slip that was just pulled into Current (gets a little pop)
  var printing = false; // animate the slips out of the printer on the next render

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NS = 'http://www.w3.org/2000/svg';
  var TRAY_NAME = { todo: 'TO DO', current: 'CURRENT', done: 'DONE' };

  var $ = function (id) { return document.getElementById(id); };

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

  function dateLabel() {
    if (!state.date) return '';
    var p = state.date.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  // ---- the scenery: scale, drifting grid, decorations ----
  function setScale() {
    // wide windows get the three trays side by side; narrower ones stack them in one column
    var wide = window.innerWidth >= 960;
    scale = wide ? Math.max(1.2, Math.min(1.6, window.innerWidth / 820)) : Math.max(1.2, Math.min(1.7, window.innerWidth / 360));
    $('desk').style.setProperty('--z', String(scale));
    document.documentElement.style.setProperty('--z', String(scale));
    $('desk').classList.toggle('narrow', !wide);
  }

  function startGrid() {
    var canvas = $('grid');
    var ctx = canvas.getContext('2d');
    var ox = 0, oy = 0, angle = 12, vx = 0, vy = 0, va = 0, tvx = 0, tvy = 0, tva = 0, frame = 0, last = 0;
    function resize() {
      var r = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * r);
      canvas.height = Math.floor(window.innerHeight * r);
      ctx.setTransform(r, 0, 0, r, 0, 0);
    }
    function loop(t) {
      requestAnimationFrame(loop);
      if (t - last < 32) return;
      last = t;
      frame++;
      if (frame % 350 === 0) {
        tvx = (Math.random() - 0.5) * 0.5;
        tvy = (Math.random() - 0.5) * 0.5;
        tva = (Math.random() - 0.5) * 0.006;
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
    requestAnimationFrame(loop);
  }

  function addDecorations() {
    var decos = [
      ['☕', 0.02, 0.38, -14, 1.1], ['🌵', 0.04, 0.7, 8, 0.95],
      ['🕯️', 0.9, 0.34, 12, 1.0], ['🍪', 0.93, 0.66, -9, 1.05],
      ['📓', 0.03, 0.9, -18, 0.9], ['🌿', 0.91, 0.9, 22, 1.1],
      ['⭐', 0.95, 0.1, -5, 0.8],
    ];
    var box = $('deco');
    decos.forEach(function (d) {
      box.appendChild(h('span', { style: 'left:' + d[1] * 100 + '%;top:' + d[2] * 100 + '%;font-size:' + 22 * d[4] + 'px;transform:rotate(' + d[3] + 'deg)' }, d[0]));
    });
  }

  // ---- checklist ticks inside info sheets, and the pulled-in slips (both kept on this device, per day) ----
  function dayKey(name) { return 'planner-' + name + '-' + state.date; }
  function loadLocal() {
    try { state.ticks = JSON.parse(localStorage.getItem(dayKey('ticks')) || '{}') || {}; } catch (e) { state.ticks = {}; }
    try { state.focus = JSON.parse(localStorage.getItem(dayKey('focus')) || '[]') || []; } catch (e) { state.focus = []; }
  }
  function saveTicks() { try { localStorage.setItem(dayKey('ticks'), JSON.stringify(state.ticks)); } catch (e) { /* storage may be blocked */ } }
  function saveFocus() { try { localStorage.setItem(dayKey('focus'), JSON.stringify(state.focus)); } catch (e) { /* storage may be blocked */ } }
  function addFocus(id) { if (state.focus.indexOf(id) < 0) { state.focus.push(id); saveFocus(); } }
  function removeFocus(id) { var i = state.focus.indexOf(id); if (i >= 0) { state.focus.splice(i, 1); saveFocus(); } }

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
  function byId(id) { return state.tasks.find(function (t) { return t.id === id; }); }

  function showError(msg) {
    state.error = msg;
    clearTimeout(errTimer);
    if (msg) errTimer = setTimeout(function () { state.error = null; render(); }, 5000);
  }

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
          showError("Couldn't sync that change");
        }
        render();
      });
    });
  }

  /** Fetches today's plan. `print` feeds the slips out of the printer (the first load and the REPRINT button). */
  function refresh(print) {
    if (holding || drag) return Promise.resolve();
    if (print) { state.loading = true; state.error = null; render(); }
    return api.getDay().then(function (day) {
      var dateChanged = state.date !== day.date;
      state.date = day.date;
      if (dateChanged) loadLocal();
      state.tasks = mergeServerDay(state.tasks, day.tasks, pendingIds());
      state.headline = day.headline;
      state.sections = day.sections;
      if (!pending.rating) state.rating = day.rating;
      state.plan = choosePlan(state.tasks, state.plan);
      // forget pulled-in slips that are gone or already done
      state.focus = state.focus.filter(function (id) { var t = byId(id); return t && !t.done; });
      saveFocus();
      var first = !state.loaded;
      state.error = null;
      state.loaded = true;
      state.loading = false;
      printing = print || first;
      render();
    }).catch(function (e) {
      state.loading = false;
      showError(e && e.message ? e.message : "can't reach server");
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
      if (!ok) { state.rating = before; showError("Couldn't sync that change"); }
      render();
    });
  }

  // ---- what each button does ----
  function pull(id) { addFocus(id); popId = id; render(); }
  function putBack(id) { removeFocus(id); render(); }
  function startTask(id) { act(id, function (t) { return pressStart(t, new Date().toISOString()); }, function () { return api.setStarted(id, true); }); }
  var undos = {};
  function finishTask(id) {
    removeFocus(id);
    var undo = freshUndo(undos[id], Date.now());
    delete undos[id];
    if (undo) {
      // ticked again right after an accidental untick: keep the original Start press and finish time
      act(id, function (t) { return Object.assign({}, tick(t), { startedAt: undo.startedAt, completedAt: undo.completedAt }); },
        function () { return api.setDone(id, true, undo); });
      return;
    }
    act(id, tick, function () { return api.setDone(id, true); });
  }
  function stopTask(id) { addFocus(id); act(id, pressStop, function () { return api.setStarted(id, false); }); }
  function redoTask(id, focus) {
    removeFocus(id);
    if (focus) addFocus(id);
    var was = byId(id);
    if (was && was.done) undos[id] = undoSnapshot(was, Date.now());
    act(id, untick, function () { return api.setDone(id, false); });
  }

  /** A slip was dropped on a tray: dropAction (logic.mjs) says what that means. */
  function drop(id, toTray) {
    var task = byId(id);
    if (!task) return;
    var action = dropAction(task, toTray, new Set(state.focus));
    if (action === 'pull') pull(id);
    else if (action === 'putback') putBack(id);
    else if (action === 'finish') finishTask(id);
    else if (action === 'redo') redoTask(id, false);
    else if (action === 'redo-focus') { popId = id; redoTask(id, true); }
    else if (action === 'blocked-running') { showError('Use the stop button to reset a running task first'); render(); }
  }

  // ---- drawing ----
  function planTasks() { return state.tasks.filter(function (t) { return t.plan === state.plan; }); }
  function hasPlanB() { return state.tasks.some(function (t) { return t.plan === 'B'; }); }

  function flagButton(task) {
    var timer = null;
    var flagIcon = svg('svg', { viewBox: '0 0 24 24' }, svg('path', { d: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z' }));
    var btn = h('button', { class: 'flagbtn' + (task.flagged ? ' on' : ''), 'aria-label': task.flagged ? 'Hold to clear flag' : 'Hold 2 seconds to flag' },
      svg('svg', { viewBox: '0 0 28 28' }, svg('circle', { class: 'ring', cx: '14', cy: '14', r: '11' })),
      h('span', { class: 'f' }, flagIcon));
    function begin(e) {
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
    function end() {
      if (timer) { clearTimeout(timer); timer = null; }
      holding = false;
      btn.classList.remove('holding');
    }
    btn.addEventListener('pointerdown', begin);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('click', function (e) { e.stopPropagation(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    return btn;
  }

  function elapsedText(task) {
    var s = startedLabel(task);
    var m = minutesSince(task.startedAt);
    return 'since ' + s + (m === null ? '' : ' · ' + m + 'm');
  }

  function slip(task, tray, next) {
    var color = TAG_COLOR[task.tag];
    var ph = phase(task);
    var open = tray === 'current' || !!state.expanded[task.id];
    var label = timeLabel(task);
    var notes = parseNotes(task.notes);

    var controls = [];
    if (tray === 'todo') {
      controls.push(h('button', { class: 'mini pull', onclick: function (e) { e.stopPropagation(); pull(task.id); } }, 'PULL >'));
    } else if (tray === 'current' && ph === 'idle') {
      controls.push(
        h('button', { class: 'go', style: 'border-color:' + color + ';color:' + color, onclick: function (e) { e.stopPropagation(); startTask(task.id); } }, 'START'),
        h('button', { class: 'mini', onclick: function (e) { e.stopPropagation(); putBack(task.id); } }, '< BACK'));
    } else if (tray === 'current' && ph === 'running') {
      controls.push(
        h('button', { class: 'go fin', style: 'border-color:' + color + ';background:' + color, onclick: function (e) { e.stopPropagation(); finishTask(task.id); } }, 'FINISH'),
        h('span', { class: 'elapsed', 'data-since': task.startedAt }, elapsedText(task)));
    } else if (tray === 'done' && open) {
      controls.push(h('button', { class: 'mini', onclick: function (e) { e.stopPropagation(); redoTask(task.id, false); } }, 'REDO'));
    }

    var stopBtn = tray === 'current' && canStop(task)
      ? h('button', { class: 'stop', 'aria-label': 'Reset start', onclick: function (e) { e.stopPropagation(); stopTask(task.id); } }, h('i'))
      : null;
    var showFlag = true; // every slip carries its flag

    var el = h('div', {
      class: 'slip' + (tray === 'done' ? ' done' : '') + (task.flagged ? ' flagged' : '') + (popId === task.id ? ' pop' : ''),
      'data-id': task.id,
      'data-tray': tray,
      style: 'border-left-color:' + color,
    },
      h('div', { class: 'grip', 'aria-hidden': 'true' }),
      h('div', { class: 'box', onclick: function (e) { e.stopPropagation(); if (task.done) redoTask(task.id, false); else finishTask(task.id); } }, task.done ? '✓' : ''),
      h('div', {
        class: 'main',
        onclick: function () { if (tray !== 'current') { state.expanded[task.id] = !state.expanded[task.id]; render(); } },
      },
        h('div', { class: 'toprow' },
          label ? h('span', { class: 'time', style: 'color:' + (task.done ? 'rgba(92,61,30,.6)' : color) }, label) : null,
          next ? h('span', { class: 'nextbadge' }, 'NEXT') : null),
        h('div', { class: 'title' }, task.title),
        task.flagged ? h('div', { class: 'flaglabel' }, 'FLAGGED: times ignored') : null,
        tray === 'done' && task.startedAt ? h('div', { class: 'startedtxt' }, 'started ' + startedLabel(task)) : null,
        open && notes.length
          ? h('div', { class: 'notes' }, notes.map(function (n) {
              return h('div', { class: 'nr' }, n.label ? h('span', { class: 'lab', style: 'color:' + color + ';border-color:' + color }, n.label) : null, h('span', { class: 'txt' }, n.text));
            }))
          : null,
        controls.length ? h('div', { class: 'controls' }, controls) : null),
      h('div', { class: 'side' },
        h('span', { class: 'tag', style: 'color:' + color + ';border-color:' + color }, TAG_LABEL[task.tag]),
        showFlag ? h('div', { class: 'flagcol' }, flagButton(task), stopBtn) : null));
    el.addEventListener('pointerdown', function (e) { onSlipDown(e, el, task.id); });
    return el;
  }

  function drawTray(tray, tasks, nextTask) {
    var el = $('tray-' + tray);
    var plate = h('div', { class: 'plate' }, h('span', {}, TRAY_NAME[tray]), h('b', {}, String(tasks.length)));
    var inner = h('div', { class: 'inner' });
    if (!state.loaded) {
      if (tray === 'todo') inner.appendChild(h('div', { class: 'hole' }, state.error ? '' : 'fetching your tasks...'));
    } else if (tasks.length === 0) {
      var msg = tray === 'todo' ? (state.tasks.length === 0 ? 'no tasks found!\nenjoy the free time ✦' : 'all clear')
        : tray === 'current' ? 'drag a slip here,\nor tap the ticket' : 'finished slips\nland here';
      inner.appendChild(h('div', { class: 'hole' }, msg));
    } else {
      tasks.forEach(function (t) { inner.appendChild(slip(t, tray, nextTask && nextTask.id === t.id)); });
    }
    el.replaceChildren(plate, inner);
  }

  function drawCenter() {
    var tabs = h('div', { class: 'tabs' });
    ['A', 'B'].forEach(function (p) {
      if (p === 'B' && !hasPlanB()) return;
      var starts = state.tasks.filter(function (t) { return t.plan === p && t.start; }).map(function (t) { return t.start; }).sort();
      tabs.appendChild(h('button', { class: 'tab' + (state.plan === p ? ' on' : ''), onclick: function () { state.plan = p; render(); } },
        'PLAN ' + p + (starts.length ? '\n' + formatClock(starts[0]) : '')));
    });
    $('center').replaceChildren(
      tabs,
      h('div', { class: 'dateline' }, dateLabel(), h('span', { class: 'verse' }, state.date ? '  ·  ' + todaysVibe : '')),
      state.headline ? h('div', { class: 'headline' }, state.headline) : null);
  }

  function drawTicket(nextTask) {
    var rack = $('rack');
    if (!state.loaded) { rack.replaceChildren(); return; }
    if (!nextTask) {
      rack.replaceChildren(h('div', { class: 'ticket none' }, h('div', { class: 'lbl' }, 'NEXT UP'), h('div', { class: 'tt' }, state.tasks.length ? 'nothing waiting' : 'no orders')));
      return;
    }
    rack.replaceChildren(h('button', { class: 'ticket', 'aria-label': 'Pull the next task into Current', onclick: function () { pull(nextTask.id); } },
      h('div', { class: 'lbl' }, 'NEXT UP'),
      timeLabel(nextTask) ? h('div', { class: 'tm' }, timeLabel(nextTask)) : null,
      h('div', { class: 'tt' }, nextTask.title),
      h('div', { class: 'go2' }, 'tap to pull >')));
  }

  function drawFoot(tasks) {
    var done = tasks.filter(function (t) { return t.done; }).length;
    var total = tasks.length;
    var bars = h('div', { class: 'bars' });
    for (var i = 0; i < total; i++) bars.appendChild(h('i', { class: i < done ? 'on' : '' }));
    var nums = h('div', { class: 'nums' });
    [1, 2, 3, 4, 5].forEach(function (n) {
      nums.appendChild(h('button', { class: state.rating === n ? 'on' : '', onclick: function () { setRating(n); } }, String(n)));
    });
    var kids = [];
    if (state.error) kids.push(h('div', { class: 'err' }, state.error));
    kids.push(h('div', { class: 'secs' }, state.sections.map(function (s) {
      return h('button', { class: 'sec', onclick: function () { state.sheet = s; render(); } }, checkProgress(s) + s.title);
    })));
    if (state.loaded && total > 0) {
      kids.push(h('div', { class: 'prog' },
        h('div', { class: 'ph' }, h('span', {}, 'PROGRESS'), h('span', {}, done + ' / ' + total)),
        bars,
        h('div', { class: 'msg' }, progressMessage(done, total))));
      kids.push(h('div', { class: 'rate' },
        h('h3', {}, 'HOW DID TODAY FEEL?'),
        nums,
        h('div', { class: 'ends' }, h('span', {}, 'drained'), h('span', {}, 'good'))));
    } else {
      kids.push(h('div'), h('div'));
    }
    kids.push(h('div', { class: 'hint' }, 'drag a slip between trays, or use its buttons · hold a flag 2 seconds if its times are wrong'));
    kids.push(h('div', { class: 'acts' },
      h('button', { onclick: function () { refresh(true); } }, state.loading ? 'FETCHING...' : '[ REPRINT ]'),
      h('button', { class: 'quiet', onclick: function () { location.reload(); } }, 'LOCK')));
    $('foot').replaceChildren.apply($('foot'), kids);
  }

  /** "2/4" for a sheet that has checklist items, else ''. */
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

  function render() {
    // remember where every slip is, so each one can glide to its new place
    var before = {};
    document.querySelectorAll('.slip[data-id]').forEach(function (el) { before[el.getAttribute('data-id')] = el.getBoundingClientRect(); });

    var tasks = planTasks();
    var trays = splitTrays(tasks, state.focus);
    var next = nextUp(tasks, state.focus);
    drawCenter();
    drawTicket(next);
    drawTray('todo', trays.todo, next);
    drawTray('current', trays.current, null);
    drawTray('done', trays.done, null);
    drawFoot(tasks);

    var old = document.querySelector('.modal');
    if (old) old.remove();
    var d = dialog();
    if (d) document.body.appendChild(d);

    var wasPrinting = printing;
    printing = false;
    var pr = $('printer').getBoundingClientRect();
    var i = 0;
    document.querySelectorAll('.slip[data-id]').forEach(function (el) {
      var id = el.getAttribute('data-id');
      var now = el.getBoundingClientRect();
      if (drag && drag.id === id && drag.started) el.classList.add('lifted');
      if (wasPrinting && el.getAttribute('data-tray') === 'todo') {
        var dx = (pr.left + pr.width / 2 - now.left - now.width / 2) / scale;
        var dy = (pr.top + pr.height - now.top) / scale;
        el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 520, delay: i * 90, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
        i++;
      } else if (before[id]) {
        var mx = (before[id].left - now.left) / scale;
        var my = (before[id].top - now.top) / scale;
        if (Math.abs(mx) + Math.abs(my) > 1) {
          el.animate([{ transform: 'translate(' + mx + 'px,' + my + 'px)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      }
    });
    popId = null;
  }

  // ---- dragging a slip between trays ----
  function trayAt(x, y) {
    var found = null;
    document.querySelectorAll('.tray').forEach(function (t) {
      var r = t.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) found = t.getAttribute('data-tray');
    });
    return found;
  }

  function onSlipDown(e, el, id) {
    if (drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, .box, .flagbtn')) return;
    // on touch screens only the grip drags, so the rest of the slip still scrolls the tray
    if (e.pointerType !== 'mouse' && !(e.target.closest && e.target.closest('.grip'))) return;
    drag = { id: id, el: el, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, started: false, ghost: null, over: null, grabX: 0, grabY: 0, moved: false };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      drag.started = true;
      var r = drag.el.getBoundingClientRect();
      drag.grabX = drag.sx - r.left;
      drag.grabY = drag.sy - r.top;
      var ghost = drag.el.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.style.width = r.width / scale + 'px';
      $('desk').appendChild(ghost);
      drag.ghost = ghost;
      drag.el.classList.add('lifted');
    }
    e.preventDefault();
    var desk = $('desk').getBoundingClientRect();
    drag.ghost.style.transform = 'translate(' + (e.clientX - drag.grabX - desk.left) / scale + 'px,' + (e.clientY - drag.grabY - desk.top) / scale + 'px) rotate(2deg)';
    var over = trayAt(e.clientX, e.clientY);
    if (over !== drag.over) {
      document.querySelectorAll('.tray.drop').forEach(function (t) { t.classList.remove('drop'); });
      if (over) $('tray-' + over).classList.add('drop');
      drag.over = over;
    }
  }

  function endDrag(e, cancelled) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    var d = drag;
    drag = null;
    document.querySelectorAll('.tray.drop').forEach(function (t) { t.classList.remove('drop'); });
    if (d.ghost) d.ghost.remove();
    if (d.started) {
      d.el.classList.remove('lifted');
      // the click that follows a drag must not open or close the slip
      var swallow = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(function () { document.removeEventListener('click', swallow, true); }, 60);
      if (!cancelled && d.over) drop(d.id, d.over);
      else render();
    }
  }

  // ---- go ----
  setScale();
  window.addEventListener('resize', setScale);
  startGrid();
  addDecorations();
  startPrinter($('printer'));
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', function (e) { endDrag(e, false); });
  document.addEventListener('pointercancel', function (e) { endDrag(e, true); });
  render();
  refresh(true);

  // the running timers count up by themselves
  setInterval(function () {
    document.querySelectorAll('.elapsed[data-since]').forEach(function (el) {
      var m = minutesSince(el.getAttribute('data-since'));
      var task = state.tasks.find(function (t) { return t.startedAt === el.getAttribute('data-since'); });
      if (task && m !== null) el.textContent = elapsedText(task);
    });
  }, 15000);

  // keep it in sync all the time: every 20 seconds, and whenever you come back to the tab
  setInterval(function () { if (document.visibilityState === 'visible') refresh(false); }, 20000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(false); });
  window.addEventListener('focus', function () { refresh(false); });
  window.addEventListener('online', function () { refresh(false); });
})();
