/* TaskForce Agenda — gedeelde agenda
 * Data in Supabase (tabellen en beveiliging: supabase/schema.sql).
 * Inloggen gaat anoniem per toestel; toegang tot een agenda krijg je via een uitnodigingslink.
 * Pushmeldingen: .github/workflows/remind.yml.
 */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function urlB64ToUint8(b) {
    var p = '='.repeat((4 - b.length % 4) % 4), raw = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }
  function b64url(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

  /* ---------- datum ---------- */
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
    if (k === t) return 'vandaag';
    if (k === addDays(t, -1)) return 'gisteren';
    if (k === addDays(t, 1)) return 'morgen';
    var d = parseKey(k); return DAY_SHORT[d.getDay()] + ' ' + d.getDate() + ' ' + MON_SHORT[d.getMonth()];
  }

  /* ---------- toestand ---------- */
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var LEADS = [0, 5, 10, 15, 30, 60];
  var CFG = { vapidPublicKey: '', supabaseUrl: '', supabaseKey: '' };
  var sb = null, me = null, space = null, members = [];
  var S = { tasks: [], done: {}, skip: {} };
  var doneByMap = {};

  function fromRow(r) {
    return {
      id: r.id, name: r.name, date: r.date || '', days: (r.days || []).map(Number), time: r.time || '',
      notify: r.notify !== false, lead: LEADS.indexOf(r.lead) > -1 ? r.lead : 0, from: r.from_date || '',
      assignee: r.assignee || null, created_by: r.created_by || null, created_at: r.created_at || ''
    };
  }
  function toRow(t) {
    return {
      id: t.id, space_id: space.id, name: t.name, date: t.days.length ? null : t.date, days: t.days, time: t.time || null,
      notify: t.notify, lead: t.lead, from_date: t.from || null, assignee: t.assignee || null
    };
  }
  function find(id) { return S.tasks.filter(function (t) { return t.id === id; })[0]; }
  function inList(m, k, id) { return (S[m][k] || []).indexOf(id) > -1; }
  function addTo(m, k, id) { (S[m][k] || (S[m][k] = [])).indexOf(id) < 0 && S[m][k].push(id); }
  function removeFrom(m, k, id) { if (S[m][k]) S[m][k] = S[m][k].filter(function (x) { return x !== id; }); }
  function occursOn(t, k) {
    if (inList('skip', k, t.id)) return false;
    return t.days.length ? t.days.indexOf(parseKey(k).getDay()) > -1 : t.date === k;
  }
  function isDone(t, k) { return inList('done', k, t.id); }
  function tasksOn(k) {
    return S.tasks.map(function (t) { return { t: t, d: isDone(t, k) }; })
      .filter(function (x) { return occursOn(x.t, k); })
      .sort(function (a, b) {
        if (a.d !== b.d) return a.d ? 1 : -1;
        if (a.t.time && b.t.time) return a.t.time.localeCompare(b.t.time) || a.t.created_at.localeCompare(b.t.created_at);
        if (a.t.time) return -1; if (b.t.time) return 1;
        return a.t.created_at.localeCompare(b.t.created_at);
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
  function member(id) { return members.filter(function (m) { return m.user_id === id; })[0]; }
  function nameOf(id) { if (id === me) return 'jou'; var m = member(id); return m ? m.name : 'iemand'; }
  var COLORS = { red: '#ef4444', blue: '#3b82f6', amber: '#f59e0b', violet: '#8b5cf6', teal: '#14b8a6', pink: '#ec4899' };
  function colorOf(id) { var m = member(id); return m && COLORS[m.color] || '#94a3b8'; }
  function initial(id) { var m = member(id); return m ? m.name.trim().charAt(0).toUpperCase() : '?'; }
  function inviteUrl() { return location.origin + location.pathname + '#join=' + space.invite_code; }

  /* ---------- Supabase ---------- */
  function fail(e, what) {
    console.error(what, e);
    toast((what || 'Opslaan mislukt') + (navigator.onLine ? '' : ': geen verbinding'));
    load();
  }
  function q(promise, what) {
    setSync('busy');
    return promise.then(function (r) {
      if (r && r.error) throw r.error;
      setSync('ok'); return r;
    }).catch(function (e) { setSync('err'); fail(e, what); throw e; });
  }
  function load() {
    if (!space) return Promise.resolve();
    var from = addDays(todayKey(), -30);
    setSync('busy');
    return Promise.all([
      sb.from('tfa_spaces').select('id,name,invite_code,created_by').eq('id', space.id).maybeSingle(),
      sb.from('tfa_members').select('user_id,name,joined_at,color').eq('space_id', space.id).order('joined_at'),
      sb.from('tfa_tasks').select('*').eq('space_id', space.id),
      sb.from('tfa_done').select('task_id,day,done_by').eq('space_id', space.id).gte('day', from),
      sb.from('tfa_skip').select('task_id,day').eq('space_id', space.id).gte('day', from)
    ]).then(function (res) {
      res.forEach(function (r) { if (r.error) throw r.error; });
      if (!res[0].data) { leftSpace(); return; }
      space = res[0].data; members = res[1].data;
      if (!member(me)) { leftSpace(); return; }
      S = { tasks: res[2].data.map(fromRow), done: {}, skip: {} };
      doneByMap = {};
      res[3].data.forEach(function (r) { addTo('done', r.day, r.task_id); doneByMap[r.task_id + '|' + r.day] = r.done_by; });
      res[4].data.forEach(function (r) { addTo('skip', r.day, r.task_id); });
      LS.set('tfa-cache', { space: space, members: members, S: S });
      setSync('ok');
      rollover();
      if (!busyEditing()) render();
    }).catch(function (e) { console.error(e); setSync('err', navigator.onLine ? 'Laden mislukt' : 'Offline'); });
  }
  var reloadTimer = null, channel = null;
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    var f = 'space_id=eq.' + space.id;
    channel = sb.channel('space-' + space.id);
    ['tfa_tasks', 'tfa_done', 'tfa_skip', 'tfa_members'].forEach(function (tbl) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: tbl, filter: f }, function () {
        clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400);
      });
    });
    channel.subscribe();
  }
  function leftSpace() {
    space = null; members = []; S = { tasks: [], done: {}, skip: {} };
    LS.set('tfa-space', null); LS.set('tfa-cache', null);
    showOnboard('welcome', 'Je hebt geen toegang meer tot deze agenda. Vraag om een nieuwe uitnodigingslink.');
  }

  /* ---------- acties op de database ---------- */
  function addTask(t) {
    S.tasks.push(t); render();
    return q(sb.from('tfa_tasks').insert(toRow(t)), 'Taak niet opgeslagen');
  }
  function updateTask(t, fields) {
    var row = {}, map = { date: 'date', days: 'days', time: 'time', notify: 'notify', lead: 'lead', from: 'from_date', assignee: 'assignee', name: 'name' };
    Object.keys(fields).forEach(function (k) { t[k] = fields[k]; });
    var full = toRow(t);
    Object.keys(fields).forEach(function (k) { var c = map[k]; row[c] = full[c]; });
    if ('days' in fields) row.date = full.date;
    render();
    return q(sb.from('tfa_tasks').update(row).eq('id', t.id), 'Wijziging niet opgeslagen');
  }
  function setDone(t, k, on) {
    if (on) { addTo('done', k, t.id); doneByMap[t.id + '|' + k] = me; } else removeFrom('done', k, t.id);
    render();
    return on
      ? q(sb.from('tfa_done').upsert({ task_id: t.id, day: k, space_id: space.id }, { onConflict: 'task_id,day', ignoreDuplicates: true }), 'Afvinken niet opgeslagen')
      : q(sb.from('tfa_done').delete().eq('task_id', t.id).eq('day', k), 'Niet opgeslagen');
  }
  function setSkip(ids, k, on) {
    ids.forEach(function (id) { if (on) addTo('skip', k, id); else removeFrom('skip', k, id); });
    render();
    if (!ids.length) return Promise.resolve();
    return on
      ? q(sb.from('tfa_skip').upsert(ids.map(function (id) { return { task_id: id, day: k, space_id: space.id }; }), { onConflict: 'task_id,day', ignoreDuplicates: true }), 'Niet opgeslagen')
      : q(sb.from('tfa_skip').delete().eq('day', k).in('task_id', ids), 'Niet opgeslagen');
  }
  // Verwijderde taken (met afvinkjes) bewaren voor "Ongedaan maken"
  function deleteTasks(list) {
    var ids = list.map(function (t) { return t.id; });
    var doneRows = [];
    Object.keys(S.done).forEach(function (k) { S.done[k].forEach(function (id) { if (ids.indexOf(id) > -1) doneRows.push({ task_id: id, day: k, space_id: space.id }); }); });
    S.tasks = S.tasks.filter(function (t) { return ids.indexOf(t.id) < 0; });
    Object.keys(S.done).forEach(function (k) { S.done[k] = S.done[k].filter(function (id) { return ids.indexOf(id) < 0; }); });
    render();
    var p = ids.length ? q(sb.from('tfa_tasks').delete().in('id', ids), 'Verwijderen mislukt') : Promise.resolve();
    return function undo() {
      list.forEach(function (t) { S.tasks.push(t); });
      doneRows.forEach(function (r) { addTo('done', r.day, r.task_id); });
      render();
      p.then(function () {
        return q(sb.from('tfa_tasks').insert(list.map(toRow)), 'Herstellen mislukt');
      }).then(function () {
        if (doneRows.length) return q(sb.from('tfa_done').insert(doneRows), 'Herstellen mislukt');
      }).catch(function () {});
    };
  }
  // Onafgemaakte eenmalige taken van eerdere dagen schuiven door naar vandaag.
  var rolling = false;
  function rollover() {
    if (rolling || !space) return;
    var t0 = todayKey();
    var late = S.tasks.filter(function (t) { return !t.days.length && t.date && t.date < t0 && !isDone(t, t.date); });
    if (!late.length) return;
    rolling = true;
    Promise.all(late.map(function (t) {
      var from = t.from || t.date; t.from = from; t.date = t0;
      return sb.from('tfa_tasks').update({ date: t0, from_date: from }).eq('id', t.id).lt('date', t0);
    })).then(function () { rolling = false; render(); }).catch(function () { rolling = false; });
  }

  /* ---------- sync-status ---------- */
  var SYNC_TITLE = { ok: 'Opgeslagen', busy: 'Bezig…', err: 'Niet opgeslagen' };
  var syncState = { kind: 'busy', text: 'Laden…' };
  function setSync(kind, text) {
    syncState = { kind: kind, text: text || SYNC_TITLE[kind] };
    var dot = $('sync-dot'); if (dot) { dot.className = 'sync-dot ' + kind; dot.title = syncState.text; }
    var s = $('sheet-sync'); if (s) s.textContent = syncState.text;
  }
  function busyEditing() { var a = document.activeElement; return a && (a.isContentEditable || a.classList.contains('time-in')); }

  /* ---------- iconen ---------- */
  var ICON = {
    check: '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    bell: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    bellOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8a21 21 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-2"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
    repeat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="Herhaalt"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    x: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  /* ---------- weergave ---------- */
  var lastAdded = null, current = todayKey(), openId = null, delChoice = null, focusTime = false, confirmAll = false, confirmTimer = null, bannerHidden = LS.get('tfa-banner-hidden', false);

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
    var show = space && members.length < 2 && !bannerHidden;
    $('banner').hidden = !show;
    if (show) $('banner').innerHTML = '<div><b>Deel deze agenda.</b><br>Stuur een link, dan kan de ander meteen meekijken en taken toevoegen.</div>' +
      '<div class="banner-actions"><button class="btn" data-b="invite">Uitnodigen</button><button class="link" data-b="later">Later</button></div>';
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
    var items = tasksOn(current), shared = members.length > 1;
    if (!items.length) { $('task-list').innerHTML = '<div class="empty"><span class="empty-icon">✌️</span><span>Geen taken voor deze dag</span></div>'; lastAdded = null; return; }
    $('task-list').innerHTML = items.map(function (t) {
      var done = isDone(t, current), open = openId === t.id, id = esc(t.id), del = delChoice === t.id;
      var bellTitle = !t.time ? 'Pushmelding: kies eerst een tijdstip' : t.notify ? 'Pushmelding ' + (t.lead ? t.lead + ' min vooraf' : 'op tijd') : 'Geen pushmelding';
      var sub = '';
      if (t.from && current === t.date) sub = 'Doorgeschoven van ' + shortDate(t.from);
      else if (done && shared) { var who = doneBy(t, current); if (who) sub = 'Afgevinkt door ' + who; }
      var h = '<div class="task-item' + (t.id === lastAdded ? ' new' : '') + (done ? ' done' : '') + (open || del ? ' open' : '') + '" data-id="' + id + '"' + (shared && t.created_by && member(t.created_by) ? ' style="box-shadow: inset 3px 0 0 ' + colorOf(t.created_by) + '" title="Toegevoegd door ' + esc(nameOf(t.created_by)) + '"' : '') + '>' +
        '<button class="check' + (done ? ' checked' : '') + '" data-act="toggle" aria-label="' + (done ? 'Niet klaar' : 'Afvinken') + '">' + (done ? ICON.check : '') + '</button>' +
        '<div class="task-main"><span class="task-text" contenteditable="true" spellcheck="false" data-act="text">' + esc(t.name) + '</span>' +
        (sub ? '<span class="from"' + (sub.indexOf('Afgevinkt door') === 0 ? ' style="color:' + colorOf(doneByMap[t.id + '|' + current]) + '"' : '') + '>' + esc(sub) + '</span>' : '') + '</div>' +
        (t.days.length ? '<span class="rep" title="' + esc(repeatLabel(t.days)) + '">' + ICON.repeat + '</span>' : '') +
        (shared && t.assignee ? '<button class="who" style="background:' + colorOf(t.assignee) + '" data-act="panel" title="Voor ' + esc(nameOf(t.assignee)) + '">' + esc(initial(t.assignee)) + '</button>' : '') +
        '<button class="opt' + (t.time ? ' on' : '') + '" data-act="panel" aria-label="Tijdstip en opties" title="Tijdstip en opties">' + ICON.clock + (t.time ? esc(t.time) : '') + '</button>' +
        '<button class="opt' + (hasNotify(t) ? ' on' : '') + '" data-act="bell" aria-label="' + esc(bellTitle) + '" title="' + esc(bellTitle) + '">' + (t.time && !t.notify ? ICON.bellOff : ICON.bell) + '</button>' +
        '<button class="del-btn" data-act="del" aria-label="Verwijderen">✕</button>' +
        '</div>';
      if (del) h += '<div class="panel del-panel" data-id="' + id + '"><span class="hint">Deze taak herhaalt. Wat wil je verwijderen?</span><div class="prow">' +
        '<button class="pill" data-act="del-day">Alleen ' + esc(shortDate(current)) + '</button>' +
        '<button class="pill" data-act="del-all">Hele reeks</button><button class="link" data-act="del-cancel">Annuleren</button></div></div>';
      else if (open) h += renderPanel(t);
      return h;
    }).join('');
    lastAdded = null;
    if (focusTime) { focusTime = false; var ti = document.querySelector('.panel .time-in'); if (ti) ti.focus(); }
  }
  function doneBy(t, k) { var u = doneByMap[t.id + '|' + k]; return u && u !== me ? nameOf(u) : ''; }
  function renderPanel(t) {
    var mode = !t.days.length ? 'once' : t.days.slice().sort().join(',') === '1,2,3,4,5' ? 'work' : t.days.length === 7 ? 'daily' : 'custom';
    var id = esc(t.id), t0 = todayKey();
    var h = '<div class="panel" data-id="' + id + '">';
    if (members.length > 1) {
      h += '<div class="prow"><span class="plabel">Voor</span><button class="pill' + (!t.assignee ? ' on' : '') + '" data-act="assign" data-who="">Iedereen</button>' +
        members.map(function (m) {
          return '<button class="pill' + (t.assignee === m.user_id ? ' on' : '') + '" data-act="assign" data-who="' + esc(m.user_id) + '"' + (t.assignee === m.user_id ? ' style="background:' + colorOf(m.user_id) + ';border-color:' + colorOf(m.user_id) + '"' : '') + '><span class="dot" style="background:' + colorOf(m.user_id) + '"></span>' + (m.user_id === me ? 'Ik' : esc(m.name)) + '</button>';
        }).join('') + '</div>';
    }
    h += '<div class="prow"><span class="plabel">Tijdstip</span><input type="time" class="time-in" data-act="time" value="' + esc(t.time) + '">' +
      (t.time ? '<button class="link" data-act="notime">Wissen</button>' : '<span class="hint">Optioneel</span>') + '</div>';
    h += '<div class="prow"><span class="plabel">Melding</span><button class="switch' + (hasNotify(t) ? ' on' : '') + '" data-act="bell"' + (t.time ? '' : ' disabled') + '><span class="track"></span>' +
      (t.time ? (hasNotify(t) ? 'Aan' : 'Uit') : 'Kies eerst een tijdstip') + '</button>' +
      (hasNotify(t) ? '<select class="time-in sel" data-act="lead" aria-label="Wanneer">' + LEADS.map(function (m) {
        return '<option value="' + m + '"' + (t.lead === m ? ' selected' : '') + '>' + (m ? m + ' min vooraf' : 'Op het tijdstip') + '</option>';
      }).join('') + '</select>' : '') + '</div>';
    if (hasNotify(t) && members.length > 1) h += '<div class="prow"><span class="plabel"></span><span class="hint">Melding gaat naar ' + (t.assignee ? esc(nameOf(t.assignee)) : 'iedereen') + '.</span></div>';
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
    var made = t.created_by && members.length > 1 ? ' · toegevoegd door ' + esc(nameOf(t.created_by)) : '';
    h += '<div class="prow" style="justify-content:space-between"><span class="hint">' + (t.days.length ? esc(repeatLabel(t.days)) : 'Alleen op ' + parseKey(t.date).getDate() + ' ' + MONTHS[parseKey(t.date).getMonth()]) + made + '</span><button class="link" data-act="close">Klaar</button></div>';
    return h + '</div>';
  }
  function render() {
    if (!space) return;
    renderStrip(); renderHeader(); renderBanner(); renderTasks(); renderSummary();
    if ($('sheet-root').innerHTML && !document.activeElement.closest('#sheet-root')) renderSheet();
  }

  /* ---------- navigatie ---------- */
  function go(k) { current = k; openId = null; delChoice = null; confirmAll = false; render(); }
  $('prev').onclick = function () { go(addDays(current, -1)); };
  $('next').onclick = function () { go(addDays(current, 1)); };
  $('today-link').onclick = function () { go(todayKey()); };
  $('week-strip').onclick = function (e) { var b = e.target.closest('[data-day]'); if (b) go(b.dataset.day); };
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
    if (b.dataset.b === 'invite') shareInvite();
    if (b.dataset.b === 'later') { bannerHidden = true; LS.set('tfa-banner-hidden', true); renderBanner(); }
  };

  /* ---------- toevoegen ---------- */
  var TIME_IN_TEXT = /(^|\s)(?:om\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/i;
  $('add-input').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing || !space) return;
    var text = this.value.trim(); if (!text) return;
    var time = '', m = text.match(TIME_IN_TEXT);
    if (m) { time = String(m[2]).padStart(2, '0') + ':' + m[3]; text = (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() || text; }
    var t = { id: uuid(), name: text.slice(0, 200), date: current, days: [], time: time, notify: true, lead: 0, from: '', assignee: null, created_by: me, created_at: new Date().toISOString() };
    lastAdded = t.id; this.value = '';
    $('add-tip').textContent = time ? 'Toegevoegd om ' + time + ', met pushmelding.' : '';
    addTask(t).catch(function () {});
  });
  $('add-input').addEventListener('focus', function () {
    if (!$('add-tip').textContent) $('add-tip').textContent = 'Tip: typ een tijd mee, bijv. "09:30 bellen", voor een tijdstip met melding.';
  });
  $('add-input').addEventListener('blur', function () { setTimeout(function () { $('add-tip').textContent = ''; }, 2500); });

  /* ---------- verwijderen ---------- */
  function removeForDay(list, label) {
    var once = list.filter(function (t) { return !t.days.length; });
    var rec = list.filter(function (t) { return t.days.length; });
    var recDone = rec.filter(function (t) { return isDone(t, current); });
    var k = current;
    openId = null; delChoice = null; confirmAll = false;
    var undoDel = deleteTasks(once);
    recDone.forEach(function (t) { setDone(t, k, false).catch(function () {}); });
    setSkip(rec.map(function (t) { return t.id; }), k, true).catch(function () {});
    toast(label || (list.length === 1 ? '1 taak verwijderd' : list.length + ' taken verwijderd'), function () {
      if (once.length) undoDel();
      setSkip(rec.map(function (t) { return t.id; }), k, false).catch(function () {});
      recDone.forEach(function (t) { setDone(t, k, true).catch(function () {}); });
    });
  }
  $('summary').onclick = function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var list = tasksOn(current);
    if (b.dataset.act === 'clear') removeForDay(list.filter(function (t) { return isDone(t, current); }));
    if (b.dataset.act === 'all') {
      if (!confirmAll) {
        confirmAll = true; renderSummary();
        clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmAll = false; renderSummary(); }, 4000);
        return;
      }
      clearTimeout(confirmTimer);
      removeForDay(list);
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
  $('task-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.dataset.act;
    if (act === 'text' || act === 'time' || act === 'lead' || act === 'movedate') return;
    var row = b.closest('[data-id]'); if (!row) return;
    var t = find(row.dataset.id); if (!t) return;
    if (act !== 'del' && act.indexOf('del-') !== 0) delChoice = null;
    var ignore = function () {};

    if (act === 'toggle') { setDone(t, current, !isDone(t, current)).catch(ignore); return; }
    if (act === 'panel') { openId = openId === t.id ? null : t.id; render(); return; }
    if (act === 'close') { openId = null; render(); return; }
    if (act === 'bell') {
      if (!t.time) { openId = t.id; focusTime = true; render(); return; }
      updateTask(t, { notify: !t.notify }).catch(ignore); return;
    }
    if (act === 'notime') { updateTask(t, { time: '' }).catch(ignore); return; }
    if (act === 'assign') { updateTask(t, { assignee: b.dataset.who || null }).catch(ignore); return; }
    if (act === 'repeat') {
      var mode = b.dataset.mode;
      if (mode === 'once') updateTask(t, { days: [], date: current }).catch(ignore);
      else updateTask(t, { date: '', from: '', days: mode === 'work' ? [1, 2, 3, 4, 5] : mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : (t.days.length && t.days.length < 7 ? t.days : [parseKey(current).getDay()]) }).catch(ignore);
      return;
    }
    if (act === 'wday') {
      var w = +b.dataset.wd, days = t.days.slice(), j = days.indexOf(w);
      if (j > -1) { if (days.length > 1) days.splice(j, 1); else return; } else days.push(w);
      updateTask(t, { days: days }).catch(ignore); return;
    }
    if (act === 'move') { moveTask(t, b.dataset.to); return; }
    if (act === 'del') {
      if (t.days.length) { delChoice = delChoice === t.id ? null : t.id; openId = null; render(); return; }
      removeForDay([t], 'Taak verwijderd'); return;
    }
    if (act === 'del-day') { removeForDay([t], 'Overgeslagen voor ' + shortDate(current)); return; }
    if (act === 'del-all') { delChoice = null; var undo = deleteTasks([t]); toast('Reeks verwijderd', undo); return; }
    if (act === 'del-cancel') { delChoice = null; render(); return; }
  });
  function moveTask(t, to) {
    if (!KEY_RE.test(to) || t.days.length) return;
    var from = t.date, fromLabel = t.from;
    openId = null;
    updateTask(t, { date: to, from: '' }).catch(function () {});
    toast('Verplaatst naar ' + shortDate(to), function () { updateTask(t, { date: from, from: fromLabel }).catch(function () {}); });
  }
  $('task-list').addEventListener('change', function (e) {
    var act = e.target.dataset.act; if (!act) return;
    var row = e.target.closest('[data-id]'); if (!row) return;
    var t = find(row.dataset.id); if (!t) return;
    var v = e.target.value;
    if (act === 'time') {
      if (v && !TIME_RE.test(v)) return;
      var f = { time: v || '' }; if (v && !t.time) f.notify = true;
      updateTask(t, f).catch(function () {});
    }
    if (act === 'lead') { var n = +v; if (LEADS.indexOf(n) > -1) updateTask(t, { lead: n }).catch(function () {}); }
    if (act === 'movedate') { if (KEY_RE.test(v) && v >= todayKey() && v !== t.date) moveTask(t, v); }
  });
  $('task-list').addEventListener('keydown', function (e) {
    if (e.target.dataset.act === 'text' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  $('task-list').addEventListener('focusout', function (e) {
    if (e.target.dataset.act !== 'text') return;
    var t = find(e.target.closest('[data-id]').dataset.id); if (!t) return;
    var v = e.target.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!v) { e.target.textContent = t.name; return; }
    if (v !== t.name) updateTask(t, { name: v }).catch(function () {});
  });

  /* ---------- uitnodigen ---------- */
  function shareInvite() {
    var url = inviteUrl();
    var text = (member(me) ? member(me).name : 'Ik') + ' nodigt je uit voor de gedeelde agenda "' + space.name + '" in TaskForce Agenda.';
    if (navigator.share) {
      navigator.share({ title: 'TaskForce Agenda', text: text, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { toast('Uitnodigingslink gekopieerd'); }, function () { openSheet(); });
    } else openSheet();
  }

  /* ---------- instellingen ---------- */
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
  function openSheet() { checkSub().then(function () { if ($('sheet-root').innerHTML) renderSheet(); }); renderSheet(); }
  function closeSheet() { $('sheet-root').innerHTML = ''; sheetMsg = ''; }
  function msg(text) { sheetMsg = text; renderSheet(); }

  function renderSheet() {
    if (!space) return;
    var scroll = document.querySelector('.sheet') ? document.querySelector('.sheet').scrollTop : 0;
    var h = '<div class="backdrop" data-s="close"><div class="sheet" role="dialog" aria-label="Instellingen">';
    h += '<div class="sheet-head"><h2>' + esc(space.name) + '</h2><button class="gear" data-s="close" aria-label="Sluiten">' + ICON.x + '</button></div>';
    h += '<p class="sheet-status"><span class="sync-dot inline ' + syncState.kind + '"></span><span id="sheet-sync">' + esc(syncState.text) + '</span></p>';

    h += '<div class="sec-title">Wie doen er mee</div><div class="card list">';
    members.forEach(function (m) {
      h += '<div class="mem"><span class="who" style="background:' + (COLORS[m.color] || '#94a3b8') + '">' + esc(m.name.charAt(0).toUpperCase()) + '</span>' + esc(m.name) +
        (m.user_id === me ? ' <span class="you">(jij)</span>' : '') + '</div>';
    });
    h += '</div>';
    h += '<div class="card" style="margin-top:8px"><p>Stuur deze link naar wie je wilt laten meedoen. Die opent hem, vult een naam in en zit erin. Ook handig voor je eigen tweede toestel.</p>' +
      '<div class="invite-box"><div class="invite-link">' + esc(inviteUrl()) + '</div>' +
      '<div class="tok-row"><button class="btn" data-s="share">' + (navigator.share ? 'Link delen' : 'Link kopiëren') + '</button><button class="btn ghost" data-s="newlink">Nieuwe link</button></div>' +
      '<p class="hint">Met "Nieuwe link" werkt de oude link niet meer. Wie al meedoet, blijft erin.</p></div></div>';

    h += '<div class="sec-title">Jouw naam</div><div class="card"><div class="name-row"><input id="my-name" maxlength="40" value="' + esc(member(me) ? member(me).name : '') + '"><button class="btn" data-s="name">Opslaan</button></div></div>';

    var rec = S.tasks.filter(function (t) { return t.days.length; }).sort(function (a, b) { return (a.time || '99').localeCompare(b.time || '99'); });
    h += '<div class="sec-title">Vaste taken</div><div class="card list">';
    if (!rec.length) h += '<p class="hint">Nog geen vaste taken. Open een taak via het klokje en kies bij Herhalen bijvoorbeeld Werkdagen.</p>';
    rec.forEach(function (t) {
      h += '<div class="rec-item"><div><div class="rec-name">' + esc(t.name) + '</div><div class="hint">' + esc(repeatLabel(t.days)) +
        (t.time ? ' · ' + esc(t.time) : '') + (members.length > 1 ? ' · ' + (t.assignee ? 'voor ' + esc(nameOf(t.assignee)) : 'iedereen') : '') +
        (hasNotify(t) ? ' · melding' + (t.lead ? ' ' + t.lead + ' min vooraf' : '') : '') + '</div></div>' +
        '<button class="link" data-s="edit" data-id="' + esc(t.id) + '">Bewerken</button></div>';
    });
    h += '</div>';

    h += '<div class="sec-title">Pushmeldingen</div><div class="card">';
    if (!pushInfo.supported) {
      h += '<p>' + (isIOS() && !isStandalone()
        ? 'Op iPhone werken meldingen alleen als TaskForce Agenda op je beginscherm staat. Tik in Safari op <b>Deel</b> → <b>Zet op beginscherm</b> en open de app vanaf daar.'
        : 'Deze browser ondersteunt geen pushmeldingen.') + '</p>';
    } else {
      h += '<p>' + (pushInfo.subscribed ? 'Meldingen staan <b>aan</b> op dit toestel.' : 'Meldingen staan <b>uit</b> op dit toestel.') + '</p>' +
        '<div>' + (pushInfo.subscribed ? '<button class="btn ghost" data-s="pushoff">Uitzetten</button>' : '<button class="btn" data-s="pushon">Meldingen aanzetten</button>') + '</div>' +
        '<p class="hint">Je krijgt meldingen voor taken voor jou en voor taken voor iedereen. Ze komen meestal binnen een paar minuten rond het ingestelde moment.' + (isIOS() ? '' : ' Met <b>Klaar</b> in de melding vink je de taak meteen af.') + '</p>';
    }
    h += '</div><p class="msg">' + esc(sheetMsg) + '</p></div></div>';
    $('sheet-root').innerHTML = h;
    var sh = document.querySelector('.sheet'); if (sh) sh.scrollTop = scroll;
  }

  $('open-settings').onclick = function () { if (space) openSheet(); };
  $('sheet-root').addEventListener('click', function (e) {
    var b = e.target.closest('[data-s]'); if (!b) return;
    var s = b.dataset.s;
    if (s === 'close') { if (e.target === b || b.tagName === 'BUTTON') closeSheet(); return; }
    if (s === 'edit') { var t = find(b.dataset.id); if (!t) return; closeSheet(); go(nextOccurrence(t)); openId = t.id; render(); var r = document.querySelector('.task-item.open'); if (r && r.scrollIntoView) r.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (s === 'share') { shareInvite(); return; }
    if (s === 'newlink') {
      sb.rpc('tfa_new_invite', { s: space.id }).then(function (r) {
        if (r.error) throw r.error; space.invite_code = r.data; msg('Nieuwe link gemaakt. De oude werkt niet meer.');
      }).catch(function () { msg('Dat lukte niet. Probeer het opnieuw.'); });
      return;
    }
    if (s === 'name') {
      var v = $('my-name').value.replace(/\s+/g, ' ').trim().slice(0, 40); if (!v) return;
      sb.from('tfa_members').update({ name: v }).eq('space_id', space.id).eq('user_id', me).then(function (r) {
        if (r.error) throw r.error; member(me).name = v; LS.set('tfa-name', v); msg('Naam opgeslagen.'); render();
      }).catch(function () { msg('Opslaan lukte niet.'); });
      return;
    }
    if (s === 'pushon') enablePush();
    if (s === 'pushoff') disablePush();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('sheet-root').innerHTML) closeSheet(); });

  function enablePush() {
    if (!CFG.vapidPublicKey) { msg('config.json ontbreekt.'); return; }
    var reg;
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Je hebt meldingen niet toegestaan. Zet ze aan in de instellingen van je toestel.');
      return navigator.serviceWorker.ready;
    }).then(function (r) {
      reg = r;
      return reg.pushManager.getSubscription().then(function (s) {
        return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(CFG.vapidPublicKey) });
      });
    }).then(function (s) {
      msg('Toestel aanmelden…');
      return sb.from('tfa_push_subs').upsert({
        endpoint: s.endpoint, space_id: space.id, user_id: me,
        p256dh: b64url(s.getKey('p256dh')), auth: b64url(s.getKey('auth')), device: deviceName()
      }, { onConflict: 'endpoint' });
    }).then(function (r) {
      if (r.error) throw new Error('Aanmelden is mislukt.');
      pushInfo.subscribed = true; msg('Meldingen staan aan.');
      return reg.showNotification('TaskForce Agenda', { body: 'Meldingen staan aan.', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    }).catch(function (e) { msg(e.message || 'Aanmelden is mislukt.'); });
  }
  function disablePush() {
    var endpoint;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { if (!s) return; endpoint = s.endpoint; return s.unsubscribe(); })
      .then(function () { if (endpoint) return sb.from('tfa_push_subs').delete().eq('endpoint', endpoint); })
      .then(function () { pushInfo.subscribed = false; msg('Meldingen staan uit op dit toestel.'); })
      .catch(function () { msg('Afmelden is mislukt.'); });
  }

  /* ---------- welkom & uitnodiging ---------- */
  function showMain() {
    $('onboard').hidden = true; $('main').hidden = false;
    render();
  }
  function showOnboard(kind, note, info) {
    $('main').hidden = true; $('onboard').hidden = false; closeSheet();
    var name = LS.get('tfa-name', '');
    var h = '<div class="ob">';
    if (kind === 'config') {
      h += '<h1>Bijna klaar</h1><p>De koppeling met de database is nog niet ingesteld. Vul <b>supabaseUrl</b> en <b>supabaseKey</b> in <code>config.json</code> in.</p>';
    } else if (kind === 'join') {
      h += '<h1>Je bent uitgenodigd</h1><p><b>' + esc(info.inviter || 'Iemand') + '</b> nodigt je uit voor de gedeelde agenda <b>' + esc(info.space_name) + '</b>.</p>' +
        '<label>Jouw naam<input id="ob-name" maxlength="40" autocomplete="given-name" value="' + esc(name) + '" placeholder="Bijv. Sanne"></label>' +
        '<button class="btn" id="ob-join">Doe mee</button>';
    } else if (kind === 'loading') {
      h += '<p class="small">Even geduld…</p>';
    } else {
      h += '<h1>Welkom bij TaskForce Agenda</h1><p>Een gedeelde takenlijst per dag, met tijdstip en pushmelding. Maak een agenda en nodig daarna iemand uit met een link.</p>' +
        '<label>Jouw naam<input id="ob-name" maxlength="40" autocomplete="given-name" value="' + esc(name) + '" placeholder="Bijv. Mark"></label>' +
        '<label>Naam van de agenda<input id="ob-space" maxlength="60" value="Onze agenda"></label>' +
        '<button class="btn" id="ob-create">Agenda maken</button>' +
        '<p class="small">Heb je een uitnodigingslink gekregen? Open die link, dan kom je meteen in de juiste agenda.</p>';
    }
    if (note) h += '<p class="err">' + esc(note) + '</p>';
    $('onboard').innerHTML = h + '</div>';
  }
  $('onboard').addEventListener('click', function (e) {
    if (e.target.id === 'ob-create') {
      var n = $('ob-name').value.trim(), sn = $('ob-space').value.trim();
      if (!n) { $('ob-name').focus(); return; }
      e.target.disabled = true; LS.set('tfa-name', n);
      sb.rpc('tfa_create_space', { space_name: sn || 'Onze agenda', my_name: n }).then(function (r) {
        if (r.error) throw r.error; enterSpace(r.data.id);
      }).catch(function (err) { showOnboard('welcome', 'Dat lukte niet: ' + (err.message || 'probeer het opnieuw')); });
    }
    if (e.target.id === 'ob-join') {
      var nm = $('ob-name').value.trim(); if (!nm) { $('ob-name').focus(); return; }
      e.target.disabled = true; LS.set('tfa-name', nm);
      sb.rpc('tfa_join_space', { code: pendingInvite, my_name: nm }).then(function (r) {
        if (r.error) throw r.error; pendingInvite = null; enterSpace(r.data, true);
      }).catch(function (err) { showOnboard('welcome', err.message || 'Deze uitnodiging werkt niet.'); });
    }
  });
  $('onboard').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { var b = $('ob-join') || $('ob-create'); if (b) b.click(); }
  });
  function enterSpace(id, joined) {
    space = { id: id, name: '', invite_code: '' }; LS.set('tfa-space', id);
    showMain(); subscribe();
    load().then(function () { if (joined) toast('Welkom in ' + space.name + '!'); });
  }

  /* ---------- links vanuit meldingen ---------- */
  var pendingInvite = null;
  function handleLink(h) {
    var m;
    if ((m = /^#join=([a-f0-9]{32})$/.exec(h))) {
      clearHash(); pendingInvite = m[1];
      showOnboard('loading');
      sb.rpc('tfa_invite_info', { code: pendingInvite }).then(function (r) {
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) { pendingInvite = null; return space ? (showMain(), toast('Deze uitnodiging is niet meer geldig')) : showOnboard('welcome', 'Deze uitnodiging is niet (meer) geldig. Vraag om een nieuwe link.'); }
        var info = r.data[0];
        if (space && space.name === info.space_name && members.length) { pendingInvite = null; showMain(); toast('Je doet al mee met ' + info.space_name); return; }
        showOnboard('join', null, info);
      }).catch(function () { showOnboard('welcome', 'De uitnodiging kon niet worden geladen. Controleer je verbinding en open de link opnieuw.'); });
      return true;
    }
    if (!space) return false;
    if ((m = /^#done=([0-9a-f-]{36})@(\d{4}-\d{2}-\d{2})$/.exec(h))) {
      clearHash();
      var t = find(m[1]);
      go(m[2]);
      if (t && occursOn(t, m[2]) && !isDone(t, m[2])) { setDone(t, m[2], true).then(function () { toast('Afgevinkt: ' + t.name); }).catch(function () {}); }
      return true;
    }
    if ((m = /^#d=(\d{4}-\d{2}-\d{2})$/.exec(h))) { clearHash(); go(m[1]); return true; }
    return false;
  }
  function clearHash() { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && typeof e.data.link === 'string') { if (S.tasks.length || !space) handleLink(e.data.link); else load().then(function () { handleLink(e.data.link); }); }
  });

  /* ---------- start ---------- */
  function start() {
    if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) { showOnboard('config'); return; }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tfa-auth' } });
    var hash = location.hash;
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) return r.data.session;
      return sb.auth.signInAnonymously().then(function (x) { if (x.error) throw x.error; return x.data.session; });
    }).then(function (session) {
      me = session.user.id;
      var sid = LS.get('tfa-space', null);
      var cache = LS.get('tfa-cache', null);
      if (sid && cache && cache.space && cache.space.id === sid) { space = cache.space; members = cache.members || []; S = cache.S || S; }
      if (hash && /^#join=/.test(hash)) { handleLink(hash); if (sid) { space = space || { id: sid }; subscribe(); load(); } return; }
      if (sid) {
        if (!space) space = { id: sid, name: '', invite_code: '' };
        showMain(); subscribe();
        return load().then(function () { if (hash) handleLink(hash); });
      }
      // Nog geen agenda op dit toestel: misschien al lid van een agenda (bijv. na herinstallatie)
      return sb.from('tfa_members').select('space_id').eq('user_id', me).limit(1).then(function (r) {
        if (r.data && r.data.length) enterSpace(r.data[0].space_id);
        else showOnboard('welcome');
      });
    }).catch(function (e) {
      console.error(e);
      showOnboard('welcome', /anonymous/i.test(e && e.message || '') ? 'Anoniem inloggen staat nog uit in Supabase (Authentication → Sign In / Providers).' : 'Kan geen verbinding maken. Controleer je internet en probeer het opnieuw.');
    });
  }

  setSync('busy', 'Laden…');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { ['vapidPublicKey', 'supabaseUrl', 'supabaseKey'].forEach(function (k) { if (typeof c[k] === 'string') CFG[k] = c[k]; }); })
    .catch(function () {}).then(start);

  var lastDay = todayKey();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !space) return;
    if (todayKey() !== lastDay) { if (current === lastDay) current = todayKey(); lastDay = todayKey(); }
    load();
  });
  window.addEventListener('hashchange', function () { if (sb) handleLink(location.hash); });
})();
