// The planner website's screen. It runs inside the unlocked page, after logic.mjs (inlined above it by build.mjs), so
// everything exported there is a plain global here. All task rules come from logic.mjs; this file only draws and wires.

(function () {
  var cfg = window.__CFG;
  var api = createApi({ baseUrl: cfg.url, token: cfg.token, fetchImpl: function (u, i) { return fetch(u, i); } });
  var root = document.getElementById('app');

  var state = {
    date: null,
    tasks: [],
    headline: null,
    sections: [],
    rating: null,
    plan: 'A',
    error: null,
    loaded: false,
    lastSync: null,
    notesOpen: {},
    sheet: null,
    ticks: {},
  };
  var pending = {}; // task id -> number of changes still on their way to the server
  var queues = {}; // task id -> promise chain, so rapid taps reach the server in order
  var holding = false; // a flag is being held: don't redraw under the finger

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

  function dateLabel() {
    if (!state.date) return '';
    var p = state.date.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  // ---- checklist ticks inside info sections (kept on this device, per day) ----
  function ticksKey() { return 'planner-ticks-' + state.date; }
  function loadTicks() {
    try { state.ticks = JSON.parse(localStorage.getItem(ticksKey()) || '{}') || {}; } catch (e) { state.ticks = {}; }
  }
  function saveTicks() {
    try { localStorage.setItem(ticksKey(), JSON.stringify(state.ticks)); } catch (e) { /* storage may be blocked */ }
  }

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

  function refresh(silent) {
    if (holding) return Promise.resolve();
    if (!silent) { state.error = null; render(); }
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
      state.lastSync = new Date();
      render();
    }).catch(function (e) {
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

  // ---- drawing ----
  function planTasks() { return state.tasks.filter(function (t) { return t.plan === state.plan; }); }
  function hasPlanB() { return state.tasks.some(function (t) { return t.plan === 'B'; }); }

  function planChip(p) {
    var starts = state.tasks.filter(function (t) { return t.plan === p && t.start; }).map(function (t) { return t.start; }).sort();
    var label = 'PLAN ' + p + (starts.length ? '\n' + formatClock(starts[0]) : '');
    return h('button', { class: 'chip' + (state.plan === p ? ' on' : ''), onclick: function () { state.plan = p; render(); } }, label);
  }

  function flagButton(task) {
    var timer = null;
    var btn = h('button', { class: 'flagbtn' + (task.flagged ? ' on' : ''), 'aria-label': task.flagged ? 'Hold to clear flag' : 'Hold 2 seconds to flag' },
      (function () {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 28 28');
        var c = document.createElementNS(ns, 'circle');
        c.setAttribute('class', 'ring');
        c.setAttribute('cx', '14'); c.setAttribute('cy', '14'); c.setAttribute('r', '11');
        svg.appendChild(c);
        return svg;
      })(),
      h('span', { class: 'f' }, '⚑'));
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
      if (s) ctl = h('div', { class: 'ctl' }, h('span', { class: 'startedtxt' }, 'started ' + s));
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
        flagButton(task),
        stopBtn));
  }

  function sheet() {
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
      h('div', { class: 'sheet' }, h('h2', {}, sec.title), lines, h('button', { class: 'close', onclick: close }, 'CLOSE')));
  }

  function render() {
    var tasks = planTasks();
    var total = tasks.length;
    var done = tasks.filter(function (t) { return t.done; }).length;
    var msg = progressMessage(done, total);

    var kids = [];
    kids.push(h('div', { class: 'top' },
      h('span', {}, state.lastSync ? 'synced ' + formatClock(String(state.lastSync.getHours()).padStart(2, '0') + ':' + String(state.lastSync.getMinutes()).padStart(2, '0')) : 'connecting...'),
      h('button', { onclick: function () { refresh(false); } }, 'REFRESH')));
    if (state.error) kids.push(h('div', { class: 'err' }, state.error));

    if (!state.loaded) {
      kids.push(h('div', { class: 'paper' }, h('div', { class: 'empty' }, state.error ? '' : 'loading...')));
    } else {
      var paper = h('div', { class: 'paper' });
      paper.appendChild(h('p', { class: 'date' }, dateLabel()));
      paper.appendChild(h('p', { class: 'sub' }, 'planner'));
      if (state.headline) {
        paper.appendChild(h('p', { class: 'headline' }, state.headline));
        paper.appendChild(h('hr', { class: 'dash' }));
      }
      if (hasPlanB()) paper.appendChild(h('div', { class: 'chips' }, planChip('A'), planChip('B')));
      if (state.sections.length) {
        paper.appendChild(h('div', { class: 'sections' }, state.sections.map(function (s) {
          return h('button', { class: 'sec', onclick: function () { state.sheet = s; render(); } }, s.title);
        })));
      }
      if (tasks.length === 0) {
        paper.appendChild(h('div', { class: 'empty' }, hasPlanB() ? 'nothing in plan ' + state.plan : 'no tasks found!\nenjoy the free time ✦'));
      } else {
        tasks.forEach(function (t) { paper.appendChild(taskRow(t)); });
        paper.appendChild(h('hr', { class: 'dash' }));
        paper.appendChild(h('div', { class: 'progress-h' }, h('span', {}, 'PROGRESS'), h('span', {}, done + ' / ' + total)));
        var bars = h('div', { class: 'bars' });
        for (var i = 0; i < total; i++) bars.appendChild(h('i', { class: i < done ? 'on' : '' }));
        paper.appendChild(bars);
        if (msg) paper.appendChild(h('div', { class: 'msg' }, msg));
        paper.appendChild(h('hr', { class: 'dash' }));
        var nums = h('div', { class: 'nums' });
        [1, 2, 3, 4, 5].forEach(function (n) {
          nums.appendChild(h('button', { class: state.rating === n ? 'on' : '', onclick: function () { setRating(n); } }, String(n)));
        });
        paper.appendChild(h('div', { class: 'rate' },
          h('h3', {}, 'HOW DID TODAY FEEL?'),
          nums,
          h('div', { class: 'ends' }, h('span', {}, 'drained'), h('span', {}, 'good'))));
        paper.appendChild(h('div', { class: 'hint' }, 'forgot to start or finish on time?\nhold the flag 2 seconds'));
      }
      kids.push(paper);
    }

    var modal = sheet();
    if (modal) kids.push(modal);
    root.replaceChildren.apply(root, kids);
  }

  // ---- keep it in sync all the time ----
  render();
  refresh(true);
  setInterval(function () {
    if (document.visibilityState === 'visible') refresh(true);
  }, 20000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(true); });
  window.addEventListener('focus', function () { refresh(true); });
  window.addEventListener('online', function () { refresh(true); });
})();
