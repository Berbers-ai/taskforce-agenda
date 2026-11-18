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
  var MON_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  function fmtKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12); }
  function todayKey() { return fmtKey(new Date()); }
  function addDays(k, n) { var d = parseKey(k); d.setDate(d.getDate() + n); return fmtKey(d); }
  function shortDate(k) {
    var t = todayKey();
    if (k === addDays(t, -1)) return 'gisteren';
    if (k === addDays(t, 1)) return 'morgen';
    var d = parseKey(k); return DAY_SHORT[d.getDay()] + ' ' + d.getDate() + ' ' + MON_SHORT[d.getMonth()];
  }

  /* ---------- data ---------- */
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var LEADS = [0, 5, 10, 15, 30, 60];
  // Valideer alles wat uit de repo of de opslag komt: alleen bekende velden in het juiste formaat.
  function clean(st) {
    var out = { tasks: [], done: {}, skip: {} };
    if (!st || !Array.isArray(st.tasks)) return out;
    st.tasks.forEach(function (t) {
      if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(t.id)) return;
      var days = (Array.isArray(t.days) ? t.days : []).filter(function (d) { return d === +d && d >= 0 && d <= 6; });
      var date = KEY_RE.test(t.date) ? t.date : '';
      if (!date && !days.length) return;
      var task = {
        id: t.id,
        name: String(t.name || '').slice(0, 200),
        date: days.length ? '' : date,
        days: days,
        time: TIME_RE.test(t.time) ? t.time : '',
        notify: t.notify !== false,
        lead: LEADS.indexOf(t.lead) > -1 ? t.lead : 0
      };
      if (!days.length && KEY_RE.test(t.from) && t.from < date) task.from = t.from;
      out.tasks.push(task);
    });
    ['done', 'skip'].forEach(function (m) {
      if (st[m] && typeof st[m] === 'object') Object.keys(st[m]).forEach(function (k) {
        if (KEY_RE.test(k) && Array.isArray(st[m][k])) out[m][k] = st[m][k].filter(function (x) { return typeof x === 'string'; });
      });
    });
    return out;
  }
  var S = clean(LS.get('rt-state', null));

  function find(id) { return S.tasks.filter(function (t) { return t.id === id; })[0]; }
  function occursOn(t, k) {
    if ((S.skip[k] || []).indexOf(t.id) > -1) return false;
    return t.days.length ? t.days.indexOf(parseKey(k).getDay()) > -1 : t.date === k;
  }
  function isDone(t, k) { return (S.done[k] || []).indexOf(t.id) > -1; }
  // Volgorde: open taken eerst (met tijd op tijd, daarna zonder tijd), voltooide onderaan.
  function tasksOn(k) {
    return S.tasks.map(function (t, i) { return { t: t, i: i, d: isDone(t, k) }; })
      .filter(function (x) { return occursOn(x.t, k); })
      .sort(function (a, b) {
        if (a.d !== b.d) return a.d ? 1 : -1;
        if (a.t.time && b.t.time) return a.t.time.localeCompare(b.t.time) || a.i - b.i;
        if (a.t.time) return -1; if (b.t.time) return 1;
        return a.i - b.i;
      }).map(function (x) { return x.t; });
  }
  function hasNotify(t) { return !!t.time && t.notify; }
  function repeatLabel(days) {
    var k = days.slice().sort().join(',');
    if (k === '1,2,3,4,5') return 'Elke werkdag';
    if (k === '0,1,2,3,4,5,6') return 'Elke dag';
    if (k === '0,6') return 'Elk weekend';
    if (days.length === 1) return 'Elke ' + DAY_NAMES[days[0]].toLowerCase();
    return 'Elke ' + [1, 2, 3, 4, 5, 6, 0].filter(function (x) { return days.indexOf(x) > -1; }).map(function (x) { return DAY_SHORT[x]; }).join(', ');
  }
  function nextOccurrence(t) {
    var k = todayKey();
    for (var i = 0; i < 8; i++) { if (occursOn(t, k)) return k; k = addDays(k, 1); }
    return todayKey();
  }
  function newId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function prune() {
    var lim21 = addDays(todayKey(), -21), lim60 = addDays(todayKey(), -60);
    ['done', 'skip'].forEach(function (m) { Object.keys(S[m]).forEach(function (k) { if (k < lim21 || !S[m][k].length) delete S[m][k]; }); });
    S.tasks = S.tasks.filter(function (t) { return t.days.length || t.date >= lim60; });
  }
  // Onafgemaakte eenmalige taken van eerdere dagen schuiven door naar vandaag.
  function rollover() {
    var t0 = todayKey(), changed = false;
    S.tasks.forEach(function (t) {
      if (!t.days.length && t.date < t0 && !isDone(t, t.date)) { t.from = t.from || t.date; t.date = t0; changed = true; }
    });
    return changed;
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
  var timer = null, pushing = false, syncState = { kind: 'busy', text: 'Laden…' };
  var SYNC_TITLE = { ok: 'Opgeslagen in GitHub', busy: 'Bezig…', local: 'Alleen op dit toestel', err: 'Niet opgeslagen' };
  function setSync(kind, text) {
    syncState = { kind: kind, text: text || SYNC_TITLE[kind] };
    var dot = $('sync-dot'); dot.className = 'sync-dot ' + kind; dot.title = syncState.text;
    var s = $('sheet-sync'); if (s) s.textContent = syncState.text;
  }
  function persist() { LS.set('rt-state', S); LS.set('rt-sha', sha); LS.set('rt-dirty', dirty); }
  function busyEditing() { var a = document.activeElement; return a && (a.isContentEditable || a.classList.contains('time-in')); }
  function afterLoad() { if (rollover()) save(); }
  function pull() {
    if (!REPO.owner || pushing) return Promise.resolve();
    return getFile('data/state.json').then(function (f) {
      if (dirty) { sha = f.sha; persist(); if (token) return push(); setSync('local'); return; }
      if (f.data) { S = clean(f.data); sha = f.sha; persist(); }
      setSync(token ? 'ok' : 'local', token ? null : 'Alleen lezen. Koppel GitHub om op te slaan.');
      afterLoad();
      if (!busyEditing()) render();
    }).catch(function (e) { setSync('err', e.status === 403 ? 'GitHub-limiet bereikt, probeer het later' : 'Offline, wijzigingen blijven bewaard op dit toestel'); });
  }
  function save() {
    prune(); dirty = true; persist();
    if (!token) { setSync('local'); return; }
    setSync('busy', 'Opslaan…');
    clearTimeout(timer); timer = setTimeout(push, 1000);
  }
  function push(retry) {
    if (pushing) { clearTimeout(timer); timer = setTimeout(push, 800); return Promise.resolve(); }
    pushing = true;
    return putFile('data/state.json', S, sha, 'Taken bijgewerkt').then(function (newSha) {
      sha = newSha; dirty = false; pushing = false; persist(); setSync('ok');
    }).catch(function (e) {
      pushing = false;
      if ((e.status === 409 || e.status === 422) && !retry) return getFile('data/state.json').then(function (f) { sha = f.sha; return push(true); });
      setSync('err', e.status === 401 || e.status === 403 ? 'Token werkt niet meer. Stel een nieuw token in.' : 'Opslaan mislukt, ik probeer het later opnieuw');
    });
  }

  /* ---------- weergave ---------- */
  var lastAdded = null, current = todayKey(), openId = null, delChoice = null, focusTime = false, confirmAll = false, confirmTimer = null, bannerHidden = false;

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
  function renderBanner() {
    var show = !token && !bannerHidden;
    $('banner').hidden = !show;
    if (show) $('banner').innerHTML = '<div><b>Bewaar je taken en krijg meldingen.</b><br>Nu staan je taken alleen op dit toestel. Koppel GitHub in een paar stappen.</div>' +
      '<div class="banner-actions"><button class="btn" data-b="setup">Instellen</button><button class="link" data-b="later">Later</button></div>';
  }
  function renderSummary() {
    var list = tasksOn(current), done = list.filter(function (t) { return isDone(t, current); });
    if (!list.length) { $('summary').innerHTML = ''; return; }
    var open = list.length - done.length;
    $('summary').innerHTML = '<span class="summary-text">' + (open ? '<strong>' + open + '</strong> open' : '🎉 Alles klaar') + (done.length ? ' &middot; ' + done.length + ' voltooid' : '') + '</span>' +
      '<span class="clear-row">' + (done.length ? '<button class="clear-btn" data-act="clear">Verwijder voltooide</button><span class="sep">·</span>' : '') +
      '<button class="clear-btn' + (confirmAll ? ' confirm' : '') + '" data-act="all">' + (confirmAll ? 'Zeker? Tik nogmaals' : 'Alles verwijderen') + '</button></span>';
  }
  function timeChip(t) {
    if (!t.time) return '';
    return esc(t.time);
  }
  function renderTasks() {
    var items = tasksOn(current);
    if (!items.length) { $('task-list').innerHTML = '<div class="empty"><span class="empty-icon">✌️</span><span>Geen taken voor deze dag</span></div>'; return; }
    $('task-list').innerHTML = items.map(function (t) {
      var done = isDone(t, current), open = openId === t.id, id = esc(t.id), del = delChoice === t.id;
      var bellTitle = !t.time ? 'Pushmelding: kies eerst een tijdstip' : t.notify ? 'Pushmelding ' + (t.lead ? t.lead + ' min vooraf' : 'op tijd') : 'Geen pushmelding';
      var h = '<div class="task-item' + (t.id === lastAdded ? ' new' : '') + (done ? ' done' : '') + (open || del ? ' open' : '') + '" data-id="' + id + '">' +
        '<button class="check' + (done ? ' checked' : '') + '" data-act="toggle" aria-label="' + (done ? 'Niet klaar' : 'Afvinken') + '">' + (done ? ICON.check : '') + '</button>' +
        '<div class="task-main"><span class="task-text" contenteditable="true" spellcheck="false" data-act="text">' + esc(t.name) + '</span>' +
        (t.from && current === t.date ? '<span class="from">Doorgeschoven van ' + esc(shortDate(t.from)) + '</span>' : '') + '</div>' +
        (t.days.length ? '<span class="rep" title="' + esc(repeatLabel(t.days)) + '">' + ICON.repeat + '</span>' : '') +
        '<button class="opt' + (t.time ? ' on' : '') + '" data-act="panel" aria-label="Tijdstip en opties" title="Tijdstip en opties">' + ICON.clock + timeChip(t) + '</button>' +
        '<button class="opt' + (hasNotify(t) ? ' on' : '') + '" data-act="bell" aria-label="' + esc(bellTitle) + '" title="' + esc(bellTitle) + '">' + (t.time && !t.notify ? ICON.bellOff : ICON.bell) + '</button>' +
        '<button class="del-btn" data-act="del" aria-label="Verwijderen">✕</button>' +
        '</div>';
      if (del) h += '<div class="panel del-panel" data-id="' + id + '"><span class="hint">Deze taak herhaalt. Wat wil je verwijderen?</span><div class="prow">' +
        '<button class="pill" data-act="del-day">Alleen ' + (current === todayKey() ? 'vandaag' : esc(shortDate(current))) + '</button>' +
        '<button class="pill" data-act="del-all">Hele reeks</button><button class="link" data-act="del-cancel">Annuleren</button></div></div>';
      else if (open) h += renderPanel(t);
      return h;
    }).join('');
    lastAdded = null;
    if (focusTime) { focusTime = false; var ti = document.querySelector('.panel .time-in'); if (ti) ti.focus(); }
  }
  function renderPanel(t) {
    var mode = !t.days.length ? 'once' : t.days.slice().sort().join(',') === '1,2,3,4,5' ? 'work' : t.days.length === 7 ? 'daily' : 'custom';
    var id = esc(t.id), t0 = todayKey();
    var h = '<div class="panel" data-id="' + id + '">';
    h += '<div class="prow"><span class="plabel">Tijdstip</span><input type="time" class="time-in" data-act="time" value="' + esc(t.time) + '">' +
      (t.time ? '<button class="link" data-act="notime">Wissen</button>' : '<span class="hint">Optioneel</span>') + '</div>';
    h += '<div class="prow"><span class="plabel">Melding</span><button class="switch' + (hasNotify(t) ? ' on' : '') + '" data-act="bell"' + (t.time ? '' : ' disabled') + '><span class="track"></span>' +
      (t.time ? (hasNotify(t) ? 'Aan' : 'Uit') : 'Kies eerst een tijdstip') + '</button>' +
      (hasNotify(t) ? '<select class="time-in sel" data-act="lead" aria-label="Wanneer">' + LEADS.map(function (m) {
        return '<option value="' + m + '"' + (t.lead === m ? ' selected' : '') + '>' + (m ? m + ' min vooraf' : 'Op het tijdstip') + '</option>';
      }).join('') + '</select>' : '') + '</div>';
    h += '<div class="prow"><span class="plabel">Herhalen</span>' +
      [['once', 'Eenmalig'], ['work', 'Werkdagen'], ['daily', 'Elke dag'], ['custom', 'Dagen']].map(function (o) {
        return '<button class="pill' + (mode === o[0] ? ' on' : '') + '" data-act="repeat" data-mode="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    if (mode === 'custom') {
      h += '<div class="prow"><span class="plabel"></span>' + [1, 2, 3, 4, 5, 6, 0].map(function (x) {
        return '<button class="pill sm' + (t.days.indexOf(x) > -1 ? ' on' : '') + '" data-act="wday" data-wd="' + x + '">' + DAY_SHORT[x] + '</button>';
      }).join('') + '</div>';
    }
    if (mode === 'once') {
      h += '<div class="prow"><span class="plabel">Verplaatsen</span>' +
        (t.date !== t0 ? '<button class="pill" data-act="move" data-to="' + t0 + '">Vandaag</button>' : '') +
        (t.date !== addDays(t0, 1) ? '<button class="pill" data-act="move" data-to="' + addDays(t0, 1) + '">Morgen</button>' : '') +
        '<input type="date" class="time-in" data-act="movedate" value="' + esc(t.date) + '" min="' + t0 + '" aria-label="Andere datum"></div>';
    }
    h += '<div class="prow" style="justify-content:space-between"><span class="hint">' + (t.days.length ? esc(repeatLabel(t.days)) : 'Alleen op ' + parseKey(t.date).getDate() + ' ' + MONTHS[parseKey(t.date).getMonth()]) + '</span><button class="link" data-act="close">Klaar</button></div>';
    return h + '</div>';
  }
  function render() { renderStrip(); renderHeader(); renderBanner(); renderTasks(); renderSummary(); }

  /* ---------- navigatie ---------- */
  function go(k) { current = k; openId = null; delChoice = null; confirmAll = false; render(); }
  $('prev').onclick = function () { go(addDays(current, -1)); };
  $('next').onclick = function () { go(addDays(current, 1)); };
  $('today-link').onclick = function () { go(todayKey()); };
  $('week-strip').onclick = function (e) { var b = e.target.closest('[data-day]'); if (b) go(b.dataset.day); };
  // Vegen over de weekbalk: vorige/volgende week
  (function () {
    var x0 = null, y0 = null, el = $('week-strip');
    el.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { el.classList.add(dx < 0 ? 'swipe-l' : 'swipe-r'); go(addDays(current, dx < 0 ? 7 : -7)); setTimeout(function () { el.classList.remove('swipe-l', 'swipe-r'); }, 250); }
    }, { passive: true });
  })();
  $('banner').onclick = function (e) {
    var b = e.target.closest('[data-b]'); if (!b) return;
    if (b.dataset.b === 'setup') openSheet();
    if (b.dataset.b === 'later') { bannerHidden = true; renderBanner(); }
  };

  /* ---------- toevoegen ---------- */
  // Een tijd in de tekst ("09:30 bellen" of "bellen om 9.30") wordt meteen het tijdstip.
  var TIME_IN_TEXT = /(^|\s)(?:om\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/i;
  $('add-input').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    var text = this.value.trim(); if (!text) return;
    var time = '', m = text.match(TIME_IN_TEXT);
    if (m) { time = String(m[2]).padStart(2, '0') + ':' + m[3]; text = (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() || text; }
    lastAdded = newId();
    S.tasks.push({ id: lastAdded, name: text.slice(0, 200), date: current, days: [], time: time, notify: true, lead: 0 });
    this.value = ''; $('add-tip').textContent = time ? 'Toegevoegd om ' + time + ', met pushmelding.' : '';
    save(); render();
  });
  $('add-input').addEventListener('focus', function () {
    if (!$('add-tip').textContent) $('add-tip').textContent = 'Tip: typ een tijd mee, bijv. "09:30 bellen", voor een tijdstip met melding.';
  });
  $('add-input').addEventListener('blur', function () { setTimeout(function () { $('add-tip').textContent = ''; }, 2500); });

  /* ---------- verwijderen ---------- */
  // Eenmalige taken gaan weg; herhalende taken worden alleen voor deze dag overgeslagen.
  function removeForDay(ids, label) {
    var snapshot = JSON.stringify(S);
    S.tasks = S.tasks.filter(function (t) { return !(ids.indexOf(t.id) > -1 && !t.days.length); });
    var rec = ids.filter(function (id) { var t = find(id); return t && t.days.length; });
    if (rec.length) S.skip[current] = (S.skip[current] || []).concat(rec);
    if (S.done[current]) S.done[current] = S.done[current].filter(function (id) { return ids.indexOf(id) < 0; });
    openId = null; delChoice = null; confirmAll = false;
    save(); render();
    toast(label || (ids.length === 1 ? '1 taak verwijderd' : ids.length + ' taken verwijderd'), undoTo(snapshot));
  }
  function undoTo(snapshot) { return function () { S = clean(JSON.parse(snapshot)); save(); render(); }; }
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

  var toastTimer = null;
  function toast(text, undo) {
    var el = $('toast');
    el.innerHTML = '<span>' + esc(text) + '</span>' + (undo ? '<button class="toast-undo">Ongedaan maken</button>' : '');
    el.classList.add('show');
    var btn = el.querySelector('button');
    if (btn) btn.onclick = function () { el.classList.remove('show'); undo(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 6000);
  }

  /* ---------- taak-acties ---------- */
  function toggleDone(t, k) {
    var arr = S.done[k] || (S.done[k] = []), i = arr.indexOf(t.id);
    if (i > -1) arr.splice(i, 1); else arr.push(t.id);
  }
  $('task-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.dataset.act;
    if (act === 'text' || act === 'time' || act === 'lead' || act === 'movedate') return;
    var row = b.closest('[data-id]'); if (!row) return;
    var t = find(row.dataset.id); if (!t) return;
    if (act !== 'del' && act.indexOf('del-') !== 0) delChoice = null;

    if (act === 'toggle') { toggleDone(t, current); save(); render(); return; }
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
      else { t.date = ''; delete t.from; t.days = mode === 'work' ? [1, 2, 3, 4, 5] : mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : (t.days.length && t.days.length < 7 ? t.days : [parseKey(current).getDay()]); }
      save(); render(); return;
    }
    if (act === 'wday') {
      var w = +b.dataset.wd, j = t.days.indexOf(w);
      if (j > -1) { if (t.days.length > 1) t.days.splice(j, 1); } else t.days.push(w);
      save(); render(); return;
    }
    if (act === 'move') { moveTask(t, b.dataset.to); return; }
    if (act === 'del') {
      if (t.days.length) { delChoice = delChoice === t.id ? null : t.id; openId = null; render(); return; }
      removeForDay([t.id], 'Taak verwijderd'); return;
    }
    if (act === 'del-day') { removeForDay([t.id], 'Overgeslagen voor ' + (current === todayKey() ? 'vandaag' : shortDate(current))); return; }
    if (act === 'del-all') {
      var snap = JSON.stringify(S);
      S.tasks = S.tasks.filter(function (z) { return z !== t; }); delChoice = null;
      save(); render(); toast('Reeks verwijderd', undoTo(snap)); return;
    }
    if (act === 'del-cancel') { delChoice = null; render(); return; }
  });
  function moveTask(t, to) {
    if (!KEY_RE.test(to) || t.days.length) return;
    var from = t.date;
    if (S.done[from]) S.done[from] = S.done[from].filter(function (id) { return id !== t.id; });
    t.date = to; delete t.from; openId = null;
    save(); render();
    toast('Verplaatst naar ' + shortDate(to), function () { t.date = from; save(); render(); });
  }
  $('task-list').addEventListener('change', function (e) {
    var act = e.target.dataset.act; if (!act) return;
    var t = find(e.target.closest('[data-id]').dataset.id); if (!t) return;
    var v = e.target.value;
    if (act === 'time') {
      if (v && !TIME_RE.test(v)) return;
      var had = !!t.time; t.time = v || ''; if (v && !had) t.notify = true;
      save(); render();
    }
    if (act === 'lead') { var n = +v; if (LEADS.indexOf(n) > -1) { t.lead = n; save(); render(); } }
    if (act === 'movedate') { if (KEY_RE.test(v) && v >= todayKey() && v !== t.date) moveTask(t, v); }
  });
  // Tekst direct in de regel bewerken
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
  function tokenUrl() {
    return 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent('TaskForce X') +
      '&description=' + encodeURIComponent('Opslag en meldingen voor TaskForce X (' + REPO.repo + ')') +
      '&target_name=' + encodeURIComponent(REPO.owner) + '&expires_in=366&contents=write';
  }
  function checkSub() {
    if (!pushInfo.supported) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { pushInfo.subscribed = !!s; }).catch(function () {});
  }
  function openSheet() { checkSub().then(function () { if ($('sheet-root').innerHTML) renderSheet(); }); renderSheet(); }
  function closeSheet() { $('sheet-root').innerHTML = ''; sheetMsg = ''; }
  function msg(text) { sheetMsg = text; renderSheet(); }

  function renderSheet() {
    var h = '<div class="backdrop" data-s="close"><div class="sheet" role="dialog" aria-label="Instellingen">';
    h += '<div class="sheet-head"><h2>Instellingen</h2><button class="gear" data-s="close" aria-label="Sluiten">' + ICON.x + '</button></div>';
    h += '<p class="sheet-status"><span class="sync-dot inline ' + syncState.kind + '"></span><span id="sheet-sync">' + esc(syncState.text) + '</span></p>';

    // Vaste taken
    var rec = S.tasks.filter(function (t) { return t.days.length; }).sort(function (a, b) { return (a.time || '99').localeCompare(b.time || '99'); });
    h += '<div class="sec-title">Vaste taken</div><div class="card list">';
    if (!rec.length) h += '<p class="hint">Nog geen vaste taken. Open een taak via het klokje en kies bij Herhalen bijvoorbeeld Werkdagen.</p>';
    rec.forEach(function (t) {
      h += '<div class="rec-item"><div><div class="rec-name">' + esc(t.name) + '</div><div class="hint">' + esc(repeatLabel(t.days)) +
        (t.time ? ' · ' + esc(t.time) : '') + (hasNotify(t) ? ' · melding' + (t.lead ? ' ' + t.lead + ' min vooraf' : '') : '') + '</div></div>' +
        '<button class="link" data-s="edit" data-id="' + esc(t.id) + '">Bewerken</button></div>';
    });
    h += '</div>';

    // Koppelen met GitHub
    h += '<div class="sec-title">Opslag in GitHub</div><div class="card">';
    if (token) {
      h += '<p>Gekoppeld met <b>' + esc(REPO.owner + '/' + REPO.repo) + '</b>. Je taken worden daar bewaard en zijn op al je toestellen gelijk.</p>' +
        '<div><button class="link" data-s="tokdel">Ontkoppelen op dit toestel</button></div>';
    } else {
      h += '<p>Koppel GitHub om je taken te bewaren en meldingen te krijgen. Dit doe je één keer per toestel.</p>' +
        '<ol><li><a href="' + esc(tokenUrl()) + '" target="_blank" rel="noopener noreferrer">Open deze voor-ingevulde GitHub-pagina</a>.</li>' +
        '<li>Kies bij <b>Repository access</b>: <b>Only select repositories</b> → <b>' + esc(REPO.repo) + '</b>.</li>' +
        '<li>Tik onderaan op <b>Generate token</b> en kopieer het token.</li>' +
        '<li>Plak het hieronder.</li></ol>' +
        '<div class="tok-row"><input class="tok-in" id="tok" type="password" autocomplete="off" placeholder="github_pat_…"><button class="btn ghost" data-s="paste">Plakken</button><button class="btn" data-s="tok">Koppelen</button></div>' +
        '<p class="hint">Het token blijft alleen op dit toestel. Wie het heeft, kan de bestanden van de app aanpassen. Deel het dus niet, en trek het in bij GitHub als je je toestel kwijtraakt.</p>';
    }
    h += '</div>';

    // Meldingen
    h += '<div class="sec-title">Pushmeldingen</div><div class="card">';
    if (!pushInfo.supported) {
      h += '<p>' + (isIOS() && !isStandalone()
        ? 'Op iPhone werken meldingen alleen als TaskForce X op je beginscherm staat. Tik in Safari op <b>Deel</b> → <b>Zet op beginscherm</b> en open de app vanaf daar.'
        : 'Deze browser ondersteunt geen pushmeldingen.') + '</p>';
    } else if (!token) {
      h += '<p class="hint">Koppel eerst GitHub hierboven.</p>';
    } else {
      h += '<p>' + (pushInfo.subscribed ? 'Meldingen staan <b>aan</b> op dit toestel.' : 'Meldingen staan <b>uit</b> op dit toestel.') + '</p>' +
        '<div>' + (pushInfo.subscribed ? '<button class="btn ghost" data-s="pushoff">Uitzetten</button>' : '<button class="btn" data-s="pushon">Meldingen aanzetten</button>') + '</div>' +
        '<p class="hint">Meldingen komen meestal binnen een paar minuten rond het ingestelde moment. ' + (isIOS() ? '' : 'Met de knop <b>Klaar</b> in de melding vink je de taak meteen af.') + '</p>';
    }
    h += '</div><p class="msg">' + esc(sheetMsg) + '</p></div></div>';
    $('sheet-root').innerHTML = h;
  }

  $('open-settings').onclick = openSheet;
  $('sheet-root').addEventListener('click', function (e) {
    var b = e.target.closest('[data-s]'); if (!b) return;
    var s = b.dataset.s;
    if (s === 'close') { if (e.target === b || b.tagName === 'BUTTON') closeSheet(); return; }
    if (s === 'edit') { var t = find(b.dataset.id); if (!t) return; closeSheet(); go(nextOccurrence(t)); openId = t.id; render(); var r = document.querySelector('.task-item.open'); if (r && r.scrollIntoView) r.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (s === 'paste') {
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (v) { $('tok').value = v.trim(); }).catch(function () { $('tok').focus(); });
      else $('tok').focus();
      return;
    }
    if (s === 'tok') {
      var tv = $('tok').value.trim();
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(tv)) { msg('Dit lijkt geen GitHub-token. Het begint met github_pat_.'); return; }
      var prev = token; token = tv; msg('Token controleren…');
      gh('').then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(); return j; }); })
        .then(function (j) {
          if (!j.permissions || !j.permissions.push) { token = prev; msg('Dit token mag niet schrijven in ' + REPO.repo + '. Kies de repo bij Repository access en Contents: Read and write.'); return; }
          LS.set('rt-token', token); bannerHidden = true;
          msg(/^ghp_/.test(token) ? 'Gekoppeld. Tip: een fine-grained token is veiliger.' : 'Gekoppeld. Zet nu de meldingen aan.');
          render(); pull();
        }).catch(function () { token = prev; msg('Dit token werkt niet voor ' + REPO.repo + '. Controleer of je de juiste repo hebt gekozen.'); });
    }
    if (s === 'tokdel') { token = ''; LS.set('rt-token', ''); setSync('local'); msg('Ontkoppeld op dit toestel.'); render(); }
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

  /* ---------- vanuit een melding ---------- */
  // #d=JJJJ-MM-DD opent die dag; #done=ID@JJJJ-MM-DD vinkt een taak af (knop "Klaar" in de melding).
  function handleLink(h) {
    var m;
    if ((m = /^#done=([A-Za-z0-9_-]{1,40})@(\d{4}-\d{2}-\d{2})$/.exec(h))) {
      var t = find(m[1]);
      if (t && occursOn(t, m[2]) && !isDone(t, m[2])) { toggleDone(t, m[2]); save(); go(m[2]); toast('Afgevinkt: ' + t.name); }
      else go(m[2]);
    } else if ((m = /^#d=(\d{4}-\d{2}-\d{2})$/.exec(h))) go(m[1]);
    else return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && typeof e.data.link === 'string') handleLink(e.data.link);
  });

  /* ---------- start ---------- */
  afterLoad();
  render();
  setSync('busy', 'Laden…');
  if (location.hash) handleLink(location.hash);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { if (c.vapidPublicKey) CFG.vapidPublicKey = String(c.vapidPublicKey); if (c.branch) CFG.branch = String(c.branch); })
    .catch(function () {}).then(pull);
  var lastDay = todayKey();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (todayKey() !== lastDay) { if (current === lastDay) current = todayKey(); lastDay = todayKey(); afterLoad(); render(); }
    pull();
  });
  window.addEventListener('hashchange', function () { handleLink(location.hash); });
  setInterval(function () { if (document.visibilityState === 'visible' && token && !dirty) pull(); }, 60000);
})();
