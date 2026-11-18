/* TaskForce X
 * Takenlijst per dag, met tijdstip, pushmelding en herhaling per taak.
 * Data: data/state.json in deze repo (via de GitHub API). Meldingen: .github/workflows/remind.yml.
 */
(function () {
  'use strict';

  /* ---------- opslag & config ---------- */
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function detectRepo() {
    var h = location.hostname, seg = location.pathname.split('/').filter(Boolean)[0];
    if (/\.github\.io$/.test(h)) return { owner: h.split('.')[0], repo: seg || h };
    return LS.get('rt-repo', { owner: '', repo: '' });
  }
  var REPO = detectRepo();
  var CFG = { vapidPublicKey: '', branch: 'main' };
  var token = LS.get('rt-token', '');
  var sha = LS.get('rt-sha', null);
  var dirty = LS.get('rt-dirty', false);

  /* ---------- datum-helpers ---------- */
  var DAY_NAMES = ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'];
  var DAY_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  var MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  function fmtKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12); }
  function todayKey() { return fmtKey(new Date()); }
  function addDays(k, n) { var d = parseKey(k); d.setDate(d.getDate() + n); return fmtKey(d); }

  /* ---------- data ---------- */
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Valideer alles wat uit de repo of de opslag komt: alleen bekende velden in het juiste formaat.
  function clean(st) {
    var out = { tasks: [], done: {}, skip: {} };
    if (!st || !Array.isArray(st.tasks)) return out;
    st.tasks.forEach(function (t) {
      if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(t.id)) return;
      var days = (Array.isArray(t.days) ? t.days : []).filter(function (d) { return d === +d && d >= 0 && d <= 6; });
      var date = KEY_RE.test(t.date) ? t.date : '';
      if (!date && !days.length) return;
      out.tasks.push({
        id: t.id,
        name: String(t.name || '').slice(0, 200),
        date: days.length ? '' : date,
        days: days,
        time: TIME_RE.test(t.time) ? t.time : '',
        notify: t.notify !== false
      });
    });
    if (st.done && typeof st.done === 'object') Object.keys(st.done).forEach(function (k) {
      if (KEY_RE.test(k) && Array.isArray(st.done[k])) out.done[k] = st.done[k].filter(function (x) { return typeof x === 'string'; });
    });
    if (st.skip && typeof st.skip === 'object') Object.keys(st.skip).forEach(function (k) {
      if (KEY_RE.test(k) && Array.isArray(st.skip[k])) out.skip[k] = st.skip[k].filter(function (x) { return typeof x === 'string'; });
    });
    return out;
  }
  var S = clean(LS.get('rt-state', null));

  function find(id) { return S.tasks.filter(function (t) { return t.id === id; })[0]; }
  function occursOn(t, k) {
    if ((S.skip[k] || []).indexOf(t.id) > -1) return false;
    return t.days.length ? t.days.indexOf(parseKey(k).getDay()) > -1 : t.date === k;
  }
  function tasksOn(k) {
    return S.tasks.map(function (t, i) { return { t: t, i: i }; })
      .filter(function (x) { return occursOn(x.t, k); })
      .sort(function (a, b) {
        if (a.t.time && b.t.time) return a.t.time.localeCompare(b.t.time) || a.i - b.i;
        if (a.t.time) return -1; if (b.t.time) return 1;
        return a.i - b.i;
      }).map(function (x) { return x.t; });
  }
  function isDone(t, k) { return (S.done[k] || []).indexOf(t.id) > -1; }
  function hasNotify(t) { return !!t.time && t.notify; }
  function repeatLabel(days) {
    var k = days.slice().sort().join(',');
    if (k === '1,2,3,4,5') return 'Elke werkdag';
    if (k === '0,1,2,3,4,5,6') return 'Elke dag';
    if (k === '0,6') return 'Elk weekend';
    if (days.length === 1) return 'Elke ' + DAY_NAMES[days[0]].toLowerCase();
    return 'Elke ' + [1, 2, 3, 4, 5, 6, 0].filter(function (x) { return days.indexOf(x) > -1; }).map(function (x) { return DAY_SHORT[x]; }).join(', ');
  }
  function newId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function prune() {
    var lim21 = addDays(todayKey(), -21), lim60 = addDays(todayKey(), -60);
    ['done', 'skip'].forEach(function (m) { Object.keys(S[m]).forEach(function (k) { if (k < lim21 || !S[m][k].length) delete S[m][k]; }); });
    S.tasks = S.tasks.filter(function (t) { return t.days.length || t.date >= lim60; });
  }

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, '')))); }
  function urlB64ToUint8(b) {
    var p = '='.repeat((4 - b.length % 4) % 4), raw = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }
  var ICON = {
    check: '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    bell: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    bellOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8a21 21 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-2"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
    repeat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="Herhaalt"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    x: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  /* ---------- GitHub ---------- */
  function gh(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + encodeURIComponent(REPO.owner) + '/' + encodeURIComponent(REPO.repo) + (path ? '/' + path : ''),
      { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store' });
  }
  function getFile(p) {
    return gh('contents/' + p + '?ref=' + CFG.branch + '&t=' + Date.now()).then(function (r) {
      if (r.status === 404) return { data: null, sha: null };
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json().then(function (j) { return { data: JSON.parse(b64dec(j.content)), sha: j.sha }; });
    });
  }
  function putFile(p, data, fileSha, msg) {
    var body = { message: msg, content: b64enc(JSON.stringify(data, null, 1) + '\n'), branch: CFG.branch };
    if (fileSha) body.sha = fileSha;
    return gh('contents/' + p, { method: 'PUT', body: JSON.stringify(body) }).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json().then(function (j) { return j.content.sha; });
    });
  }

  /* ---------- sync ---------- */
  var timer = null, pushing = false;
  function setSync(kind, text) { var el = $('sync'); el.className = 'sync' + (kind === 'ok' ? ' ok' : ''); el.textContent = text || ''; }
  function persist() { LS.set('rt-state', S); LS.set('rt-sha', sha); LS.set('rt-dirty', dirty); }
  function busyEditing() { var a = document.activeElement; return a && (a.isContentEditable || a.classList.contains('time-in')); }
  function pull() {
    if (!REPO.owner || pushing) return Promise.resolve();
    return getFile('data/state.json').then(function (f) {
      if (dirty) { sha = f.sha; persist(); if (token) return push(); setSync('', 'Alleen op dit toestel'); return; }
      if (f.data) { S = clean(f.data); sha = f.sha; persist(); }
      setSync(token ? 'ok' : '', token ? '● Gesynchroniseerd' : 'Alleen lezen');
      if (!busyEditing()) render();
    }).catch(function (e) { setSync('', e.status === 403 ? 'GitHub-limiet, later opnieuw' : '⚠ Offline'); });
  }
  function save() {
    prune(); dirty = true; persist();
    if (!token) { setSync('', 'Alleen op dit toestel'); return; }
    setSync('', '⟳ Opslaan…');
    clearTimeout(timer); timer = setTimeout(push, 1000);
  }
  function push(retry) {
    if (pushing) { clearTimeout(timer); timer = setTimeout(push, 800); return Promise.resolve(); }
    pushing = true;
    return putFile('data/state.json', S, sha, 'Taken bijgewerkt').then(function (newSha) {
      sha = newSha; dirty = false; pushing = false; persist(); setSync('ok', '● Gesynchroniseerd');
    }).catch(function (e) {
      pushing = false;
      if ((e.status === 409 || e.status === 422) && !retry) return getFile('data/state.json').then(function (f) { sha = f.sha; return push(true); });
      setSync('', e.status === 401 || e.status === 403 ? '⚠ Token werkt niet' : '⚠ Opslaan mislukt');
    });
  }

  /* ---------- weergave ---------- */
  var current = todayKey(), openId = null, confirmDel = null, focusTime = false, confirmAll = false, confirmTimer = null;

  function renderStrip() {
    var d = parseKey(current), mon = new Date(d); mon.setDate(d.getDate() - (d.getDay() + 6) % 7);
    var t = todayKey(), h = '';
    for (var i = 0; i < 7; i++) {
      var x = new Date(mon); x.setDate(mon.getDate() + i); var k = fmtKey(x);
      var open = tasksOn(k).some(function (task) { return !isDone(task, k); });
      h += '<button class="week-day' + (k === current ? ' active' : '') + (k === t ? ' is-today' : '') + (open ? ' has-tasks' : '') + '" data-day="' + k + '">' +
        '<span class="wd-label">' + DAY_SHORT[x.getDay()] + '</span><span class="wd-num">' + x.getDate() + '</span><span class="wd-dot"></span></button>';
    }
    $('week-strip').innerHTML = h;
  }
  function renderHeader() {
    var d = parseKey(current), t = todayKey();
    var label = current === t ? 'Vandaag' : current === addDays(t, 1) ? 'Morgen' : current === addDays(t, -1) ? 'Gisteren' : DAY_NAMES[d.getDay()];
    $('date-day').textContent = label;
    $('date-sub').textContent = (label !== DAY_NAMES[d.getDay()] ? DAY_NAMES[d.getDay()].toLowerCase() + ' ' : '') + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    $('today-link').hidden = current === t;
  }
  function renderSummary() {
    var list = tasksOn(current), done = list.filter(function (t) { return isDone(t, current); });
    if (!list.length) { $('summary').innerHTML = ''; return; }
    var open = list.length - done.length;
    $('summary').innerHTML = '<span class="summary-text">' + (open ? '<strong>' + open + '</strong> open' : '🎉 Alles klaar') + (done.length ? ' &middot; ' + done.length + ' voltooid' : '') + '</span>' +
      '<span class="clear-row">' + (done.length ? '<button class="clear-btn" data-act="clear">Verwijder voltooide</button><span class="sep">·</span>' : '') +
      '<button class="clear-btn' + (confirmAll ? ' confirm' : '') + '" data-act="all">' + (confirmAll ? 'Zeker? Tik nogmaals' : 'Alles verwijderen') + '</button></span>';
  }
  function renderTasks() {
    var items = tasksOn(current);
    if (!items.length) { $('task-list').innerHTML = '<div class="empty"><span class="empty-icon">✌️</span><span>Geen taken voor deze dag</span></div>'; return; }
    $('task-list').innerHTML = items.map(function (t) {
      var done = isDone(t, current), open = openId === t.id, id = esc(t.id);
      var h = '<div class="task-item' + (done ? ' done' : '') + (open ? ' open' : '') + '" data-id="' + id + '">' +
        '<button class="check' + (done ? ' checked' : '') + '" data-act="toggle" aria-label="Afvinken">' + (done ? ICON.check : '') + '</button>' +
        '<span class="task-text" contenteditable="true" spellcheck="false" data-act="text">' + esc(t.name) + '</span>' +
        (t.days.length ? '<span class="rep" title="' + esc(repeatLabel(t.days)) + '">' + ICON.repeat + '</span>' : '') +
        '<button class="opt' + (t.time ? ' on' : '') + '" data-act="panel" aria-label="Tijdstip" title="Tijdstip en herhalen">' + ICON.clock + (t.time ? esc(t.time) : '') + '</button>' +
        '<button class="opt' + (hasNotify(t) ? ' on' : '') + '" data-act="bell" aria-label="Pushmelding" title="Pushmelding ' + (hasNotify(t) ? 'aan' : 'uit') + '">' + (t.time && !t.notify ? ICON.bellOff : ICON.bell) + '</button>' +
        '<button class="del-btn' + (confirmDel === t.id ? ' confirm' : '') + '" data-act="del" aria-label="Verwijderen">' + (confirmDel === t.id ? 'Hele reeks?' : '✕') + '</button>' +
        '</div>';
      if (open) h += renderPanel(t);
      return h;
    }).join('');
    if (focusTime) { focusTime = false; var ti = document.querySelector('.panel .time-in'); if (ti) ti.focus(); }
  }
  function renderPanel(t) {
    var mode = !t.days.length ? 'once' : t.days.slice().sort().join(',') === '1,2,3,4,5' ? 'work' : t.days.length === 7 ? 'daily' : 'custom';
    var id = esc(t.id);
    var h = '<div class="panel" data-id="' + id + '">';
    h += '<div class="prow"><span class="plabel">Tijdstip</span><input type="time" class="time-in" data-act="time" value="' + esc(t.time) + '">' +
      (t.time ? '<button class="link" data-act="notime">Wissen</button>' : '<span class="hint">Optioneel</span>') + '</div>';
    h += '<div class="prow"><span class="plabel">Melding</span><button class="switch' + (hasNotify(t) ? ' on' : '') + '" data-act="bell"' + (t.time ? '' : ' disabled') + '><span class="track"></span>' +
      (t.time ? (hasNotify(t) ? 'Pushmelding om ' + esc(t.time) : 'Geen melding') : 'Kies eerst een tijdstip') + '</button></div>';
    h += '<div class="prow"><span class="plabel">Herhalen</span>' +
      [['once', 'Eenmalig'], ['work', 'Werkdagen'], ['daily', 'Elke dag'], ['custom', 'Dagen']].map(function (o) {
        return '<button class="pill' + (mode === o[0] ? ' on' : '') + '" data-act="repeat" data-mode="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    if (mode === 'custom') {
      h += '<div class="prow"><span class="plabel"></span>' + [1, 2, 3, 4, 5, 6, 0].map(function (x) {
        return '<button class="pill sm' + (t.days.indexOf(x) > -1 ? ' on' : '') + '" data-act="wday" data-wd="' + x + '">' + DAY_SHORT[x] + '</button>';
      }).join('') + '</div>';
    }
    h += '<div class="prow" style="justify-content:space-between"><span class="hint">' + (t.days.length ? esc(repeatLabel(t.days)) : 'Alleen op ' + parseKey(t.date).getDate() + ' ' + MONTHS[parseKey(t.date).getMonth()]) + '</span><button class="link" data-act="close">Klaar</button></div>';
    return h + '</div>';
  }
  function render() { renderStrip(); renderHeader(); renderTasks(); renderSummary(); }

  /* ---------- acties ---------- */
  function go(k) { current = k; openId = null; confirmDel = null; confirmAll = false; render(); }

  $('prev').onclick = function () { go(addDays(current, -1)); };
  $('next').onclick = function () { go(addDays(current, 1)); };
  $('today-link').onclick = function () { go(todayKey()); };
  $('week-strip').onclick = function (e) { var b = e.target.closest('[data-day]'); if (b) go(b.dataset.day); };

  // Taak toevoegen. Een tijd in de tekst ("09:30 bellen" of "bellen om 9.30") wordt meteen het tijdstip.
  var TIME_IN_TEXT = /(^|\s)(?:om\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/i;
  $('add-input').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    var text = this.value.trim(); if (!text) return;
    var time = '', m = text.match(TIME_IN_TEXT);
    if (m) { time = String(m[2]).padStart(2, '0') + ':' + m[3]; text = (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() || text; }
    S.tasks.push({ id: newId(), name: text.slice(0, 200), date: current, days: [], time: time, notify: true });
    this.value = ''; $('add-tip').textContent = time ? 'Toegevoegd met tijdstip ' + time + ' en pushmelding.' : '';
    save(); render();
  });
  $('add-input').addEventListener('focus', function () {
    if (!$('add-tip').textContent) $('add-tip').textContent = 'Tip: typ een tijd mee, bijv. "09:30 bellen", voor een tijdstip met melding.';
  });
  $('add-input').addEventListener('blur', function () { setTimeout(function () { $('add-tip').textContent = ''; }, 2500); });

  // Verwijderen per dag. Eenmalige taken gaan weg; herhalende taken worden alleen voor deze dag overgeslagen.
  function removeForDay(ids) {
    var snapshot = JSON.stringify(S);
    S.tasks = S.tasks.filter(function (t) { return !(ids.indexOf(t.id) > -1 && !t.days.length); });
    var rec = ids.filter(function (id) { var t = find(id); return t && t.days.length; });
    if (rec.length) S.skip[current] = (S.skip[current] || []).concat(rec);
    if (S.done[current]) S.done[current] = S.done[current].filter(function (id) { return ids.indexOf(id) < 0; });
    openId = null; confirmDel = null; confirmAll = false;
    save(); render();
    toast(ids.length === 1 ? '1 taak verwijderd' : ids.length + ' taken verwijderd', function () { S = clean(JSON.parse(snapshot)); save(); render(); });
  }
  $('summary').onclick = function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var list = tasksOn(current);
    if (b.dataset.act === 'clear') removeForDay(list.filter(function (t) { return isDone(t, current); }).map(function (t) { return t.id; }));
    if (b.dataset.act === 'all') {
      if (!confirmAll) {
        confirmAll = true; renderSummary();
        clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmAll = false; renderSummary(); }, 4000);
        return;
      }
      clearTimeout(confirmTimer);
      removeForDay(list.map(function (t) { return t.id; }));
    }
  };

  // Melding onderin met "Ongedaan maken"
  var toastTimer = null;
  function toast(text, undo) {
    var el = $('toast');
    el.innerHTML = '<span>' + esc(text) + '</span>' + (undo ? '<button class="toast-undo">Ongedaan maken</button>' : '');
    el.classList.add('show');
    var btn = el.querySelector('button');
    if (btn) btn.onclick = function () { el.classList.remove('show'); undo(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 6000);
  }

  $('task-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.dataset.act === 'text' || b.dataset.act === 'time') return;
    var row = b.closest('[data-id]'); if (!row) return;
    var t = find(row.dataset.id); if (!t) return;
    var act = b.dataset.act;
    if (act !== 'del') confirmDel = null;

    if (act === 'toggle') {
      var arr = S.done[current] || (S.done[current] = []), i = arr.indexOf(t.id);
      if (i > -1) arr.splice(i, 1); else arr.push(t.id);
      save(); render(); return;
    }
    if (act === 'panel') { openId = openId === t.id ? null : t.id; render(); return; }
    if (act === 'close') { openId = null; render(); return; }
    if (act === 'bell') {
      if (!t.time) { openId = t.id; focusTime = true; render(); return; }
      t.notify = !t.notify; save(); render(); return;
    }
    if (act === 'notime') { t.time = ''; save(); render(); return; }
    if (act === 'repeat') {
      var mode = b.dataset.mode;
      if (mode === 'once') { t.days = []; t.date = current; }
      else { t.date = ''; t.days = mode === 'work' ? [1, 2, 3, 4, 5] : mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : (t.days.length ? t.days : [parseKey(current).getDay()]); }
      if (mode === 'custom' && t.days.length === 7) t.days = [parseKey(current).getDay()];
      save(); render(); return;
    }
    if (act === 'wday') {
      var w = +b.dataset.wd, j = t.days.indexOf(w);
      if (j > -1) { if (t.days.length > 1) t.days.splice(j, 1); } else t.days.push(w);
      save(); render(); return;
    }
    if (act === 'del') {
      if (t.days.length && confirmDel !== t.id) { confirmDel = t.id; render(); return; }
      S.tasks = S.tasks.filter(function (z) { return z !== t; });
      confirmDel = null; if (openId === t.id) openId = null;
      save(); render(); return;
    }
  });

  // Tijdstip wijzigen
  $('task-list').addEventListener('change', function (e) {
    if (!e.target.classList.contains('time-in')) return;
    var t = find(e.target.closest('[data-id]').dataset.id); if (!t) return;
    var v = e.target.value;
    if (v && !TIME_RE.test(v)) return;
    var had = !!t.time; t.time = v || ''; if (v && !had) t.notify = true;
    save(); render();
  });

  // Tekst bewerken (zoals in TaskForce: direct in de regel)
  $('task-list').addEventListener('keydown', function (e) {
    if (e.target.dataset.act === 'text' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  $('task-list').addEventListener('focusout', function (e) {
    if (e.target.dataset.act !== 'text') return;
    var t = find(e.target.closest('[data-id]').dataset.id); if (!t) return;
    var v = e.target.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!v) { e.target.textContent = t.name; return; }
    if (v !== t.name) { t.name = v; save(); }
  });

  /* ---------- instellingen & meldingen ---------- */
  var pushInfo = { supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window, subscribed: false }, sheetMsg = '';
  function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }
  function deviceName() {
    var u = navigator.userAgent;
    return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Toestel';
  }
  function checkSub() {
    if (!pushInfo.supported) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { pushInfo.subscribed = !!s; }).catch(function () {});
  }
  function openSheet() { checkSub().then(renderSheet); renderSheet(); }
  function closeSheet() { $('sheet-root').innerHTML = ''; sheetMsg = ''; }
  function msg(text) { sheetMsg = text; renderSheet(); }

  function renderSheet() {
    var h = '<div class="backdrop" data-s="close"><div class="sheet" role="dialog" aria-label="Instellingen">';
    h += '<div class="sheet-head"><h2>Instellingen</h2><button class="gear" data-s="close" aria-label="Sluiten">' + ICON.x + '</button></div>';
    h += '<div class="sec-title">Pushmeldingen</div><div class="card">';
    if (!pushInfo.supported) {
      h += '<p>' + (isIOS() && !isStandalone()
        ? 'Op iPhone werken meldingen alleen als TaskForce X op je beginscherm staat. Tik in Safari op <b>Deel</b> → <b>Zet op beginscherm</b> en open de app vanaf daar.'
        : 'Deze browser ondersteunt geen pushmeldingen.') + '</p>';
    } else {
      h += '<p>' + (pushInfo.subscribed ? 'Meldingen staan <b>aan</b> op dit toestel.' : 'Meldingen staan <b>uit</b> op dit toestel.') + '</p>';
      h += '<div>' + (pushInfo.subscribed
        ? '<button class="btn ghost" data-s="pushoff">Uitzetten</button>'
        : '<button class="btn" data-s="pushon"' + (token ? '' : ' disabled') + '>Meldingen aanzetten</button>') + '</div>';
      if (!token && !pushInfo.subscribed) h += '<p class="hint">Stel eerst hieronder je GitHub-token in.</p>';
    }
    h += '</div>';
    h += '<div class="sec-title">Opslag in GitHub</div><div class="card">';
    h += '<p>Je taken staan in <b>' + esc(REPO.owner + '/' + REPO.repo) + '</b>. Om op te slaan en meldingen te gebruiken heeft de app een token nodig. Dat blijft alleen op dit toestel.</p>';
    h += '<div class="tok-row"><input class="tok-in" id="tok" type="password" autocomplete="off" placeholder="github_pat_…" value="' + esc(token) + '"><button class="btn" data-s="tok">Opslaan</button></div>';
    if (token) h += '<div><button class="link" data-s="tokdel">Token verwijderen van dit toestel</button></div>';
    h += '<ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → Fine-grained token</a>.</li>' +
      '<li>Repository access: <b>Only select repositories</b> → <b>' + esc(REPO.repo) + '</b>.</li>' +
      '<li>Permissions → Repository → <b>Contents: Read and write</b>. Verder niets.</li>' +
      '<li>Maak het token aan en plak het hierboven.</li></ol>';
    h += '<p class="hint">Wie dit token heeft, kan de bestanden van de app aanpassen. Deel het niet en trek het in als je je toestel kwijtraakt.</p>';
    h += '</div><p class="msg" style="margin-top:12px">' + esc(sheetMsg) + '</p></div></div>';
    $('sheet-root').innerHTML = h;
  }

  $('open-settings').onclick = openSheet;
  $('sheet-root').addEventListener('click', function (e) {
    var b = e.target.closest('[data-s]'); if (!b) return;
    if (b.dataset.s === 'close') { if (e.target === b || b.tagName === 'BUTTON') closeSheet(); return; }
    var s = b.dataset.s;
    if (s === 'tok') {
      var tv = $('tok').value.trim();
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(tv)) { msg('Dit lijkt geen GitHub-token.'); return; }
      token = tv; LS.set('rt-token', token); msg('Token controleren…');
      gh('').then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(); return j; }); })
        .then(function (j) {
          if (!j.permissions || !j.permissions.push) { msg('Dit token heeft geen schrijfrechten op deze repo.'); return; }
          msg(/^ghp_/.test(token) ? 'Token werkt. Gebruik liever een fine-grained token.' : 'Token werkt.');
          pull();
        }).catch(function () { msg('Dit token werkt niet voor deze repo.'); });
    }
    if (s === 'tokdel') { token = ''; LS.set('rt-token', ''); setSync('', 'Alleen lezen'); msg('Token verwijderd.'); }
    if (s === 'pushon') enablePush();
    if (s === 'pushoff') disablePush();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('sheet-root').innerHTML) closeSheet(); });

  function enablePush() {
    if (!CFG.vapidPublicKey) { msg('config.json ontbreekt.'); return; }
    var reg, sub;
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Je hebt meldingen niet toegestaan. Zet ze aan in de instellingen van je toestel.');
      return navigator.serviceWorker.ready;
    }).then(function (r) {
      reg = r;
      return reg.pushManager.getSubscription().then(function (s) {
        return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(CFG.vapidPublicKey) });
      });
    }).then(function (s) { sub = s.toJSON(); msg('Toestel aanmelden…'); return getFile('data/subscriptions.json'); })
      .then(function (f) {
        var list = (Array.isArray(f.data) ? f.data : []).filter(function (x) { return x && x.endpoint !== sub.endpoint; });
        list.push({ endpoint: sub.endpoint, keys: sub.keys, device: deviceName(), added: new Date().toISOString() });
        return putFile('data/subscriptions.json', list, f.sha, 'Toestel aangemeld voor meldingen');
      }).then(function () {
        pushInfo.subscribed = true; msg('Meldingen staan aan.');
        return reg.showNotification('TaskForce X', { body: 'Meldingen staan aan.', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
      }).catch(function (e) { msg(e.message && !/^HTTP/.test(e.message) ? e.message : 'Aanmelden is mislukt.'); });
  }
  function disablePush() {
    var endpoint;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { if (!s) return; endpoint = s.endpoint; return s.unsubscribe(); })
      .then(function () { return token && endpoint ? getFile('data/subscriptions.json') : null; })
      .then(function (f) {
        if (!f) return;
        var list = (Array.isArray(f.data) ? f.data : []).filter(function (x) { return x && x.endpoint !== endpoint; });
        return putFile('data/subscriptions.json', list, f.sha, 'Toestel afgemeld voor meldingen');
      })
      .then(function () { pushInfo.subscribed = false; msg('Meldingen staan uit op dit toestel.'); })
      .catch(function () { msg('Afmelden is mislukt.'); });
  }

  /* ---------- start ---------- */
  render();
  setSync('', '⟳ Laden…');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { if (c.vapidPublicKey) CFG.vapidPublicKey = String(c.vapidPublicKey); if (c.branch) CFG.branch = String(c.branch); })
    .catch(function () {}).then(pull);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pull();
  });
  setInterval(function () { if (document.visibilityState === 'visible' && token && !dirty) pull(); }, 60000);
})();
