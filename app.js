/* Terugkerende taken — PWA
 * Data staat in deze repo (data/state.json) en wordt via de GitHub API gelezen en geschreven.
 * Pushmeldingen worden verstuurd door .github/workflows/remind.yml.
 */
(function () {
  'use strict';

  // ---------- config & opslag ----------
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function detectRepo() {
    var h = location.hostname, seg = location.pathname.split('/').filter(Boolean)[0];
    if (/\.github\.io$/.test(h)) return { owner: h.split('.')[0], repo: seg || (h.split('.')[0] + '.github.io') };
    return LS.get('rt-repo', { owner: '', repo: '' });
  }
  var REPO = detectRepo();
  var CFG = { vapidPublicKey: '', timeZone: 'Europe/Amsterdam', branch: 'main' };
  var token = LS.get('rt-token', '');
  var S = LS.get('rt-state', null) || { tasks: [], done: {} };
  var sha = LS.get('rt-sha', null);
  var dirty = LS.get('rt-dirty', false);

  // ---------- helpers ----------
  var DAYN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  var DAYL = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  var MON = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  var BELL = '<svg width="12" height="12" viewBox="0 0 24 24" style="vertical-align:-1px" aria-label="Melding aan"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function key(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function isToday(d) { return key(d) === key(new Date()); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function blank() { return { name: '', days: [1, 2, 3, 4, 5], time: '', notify: true }; }
  function notifies(t) { return !!t.time && t.notify !== false; }
  function tasksFor(d) {
    var w = d.getDay();
    return S.tasks.filter(function (t) { return t.days.indexOf(w) > -1; })
      .sort(function (a, b) { return (a.time || '99').localeCompare(b.time || '99') || a.name.localeCompare(b.name); });
  }
  function daysLabel(ds) {
    var k = ds.slice().sort().join(',');
    if (k === '1,2,3,4,5') return 'Werkdagen';
    if (k === '0,1,2,3,4,5,6') return 'Elke dag';
    if (k === '0,6') return 'Weekend';
    return [1, 2, 3, 4, 5, 6, 0].filter(function (x) { return ds.indexOf(x) > -1; }).map(function (x) { return DAYN[x]; }).join(', ');
  }
  function weekDates() {
    var t = new Date(), m = new Date(t); m.setDate(t.getDate() - (t.getDay() + 6) % 7);
    var a = []; for (var i = 0; i < 7; i++) { var d = new Date(m); d.setDate(m.getDate() + i); a.push(d); } return a;
  }
  function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, '')))); }
  function urlB64ToUint8(b) {
    var p = '='.repeat((4 - b.length % 4) % 4), raw = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }

  // ---------- GitHub API ----------
  function gh(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + REPO.owner + '/' + REPO.repo + '/' + path,
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

  // ---------- sync ----------
  var sync = { state: 'idle', msg: '' }, timer = null, pushing = false;
  function setSync(state, msg) { sync = { state: state, msg: msg || '' }; render(); }
  function persistLocal() { LS.set('rt-state', S); LS.set('rt-sha', sha); LS.set('rt-dirty', dirty); }
  function prune() {
    var lim = new Date(); lim.setDate(lim.getDate() - 21); var lk = key(lim);
    Object.keys(S.done).forEach(function (k) { if (k < lk) delete S.done[k]; });
  }
  function pull() {
    if (!REPO.owner) return Promise.resolve();
    setSync('busy', 'Ophalen…');
    return getFile('data/state.json').then(function (f) {
      if (dirty) { sha = f.sha; persistLocal(); if (token) return push(); setSync('idle', 'Alleen op dit toestel'); return; }
      if (f.data && f.data.tasks) { S = f.data; S.done = S.done || {}; sha = f.sha; }
      persistLocal(); setSync(token ? 'ok' : 'idle', token ? 'Gesynchroniseerd' : 'Alleen lezen');
    }).catch(function (e) { setSync('err', e.status === 403 ? 'GitHub-limiet bereikt, probeer later' : 'Offline'); });
  }
  function save() {
    prune(); dirty = true; persistLocal(); render();
    if (!token) { setSync('idle', 'Alleen op dit toestel'); return; }
    clearTimeout(timer); timer = setTimeout(push, 1200);
  }
  function push(retry) {
    if (pushing) { clearTimeout(timer); timer = setTimeout(push, 800); return Promise.resolve(); }
    pushing = true; setSync('busy', 'Opslaan…');
    return putFile('data/state.json', S, sha, 'Taken bijgewerkt').then(function (newSha) {
      sha = newSha; dirty = false; persistLocal(); pushing = false; setSync('ok', 'Opgeslagen');
    }).catch(function (e) {
      pushing = false;
      if ((e.status === 409 || e.status === 422) && !retry) {
        return getFile('data/state.json').then(function (f) { sha = f.sha; return push(true); });
      }
      setSync('err', e.status === 401 || e.status === 403 ? 'Token ongeldig of zonder schrijfrechten' : 'Opslaan mislukt, later opnieuw');
    });
  }

  // ---------- meldingen ----------
  var pushInfo = { supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window, subscribed: false };
  function checkSub() {
    if (!pushInfo.supported) return;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { pushInfo.subscribed = !!s; render(); }).catch(function () {});
  }
  function enablePush() {
    if (!token) { setSync('err', 'Vul eerst je GitHub-token in'); return; }
    if (!CFG.vapidPublicKey) { setSync('err', 'config.json ontbreekt'); return; }
    var reg, sub;
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Geen toestemming voor meldingen');
      return navigator.serviceWorker.ready;
    }).then(function (r) {
      reg = r;
      return reg.pushManager.getSubscription().then(function (s) {
        return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(CFG.vapidPublicKey) });
      });
    }).then(function (s) {
      sub = s.toJSON();
      setSync('busy', 'Toestel registreren…');
      return getFile('data/subscriptions.json');
    }).then(function (f) {
      var list = (f.data || []).filter(function (x) { return x.endpoint !== sub.endpoint; });
      list.push({ endpoint: sub.endpoint, keys: sub.keys, device: deviceName(), added: new Date().toISOString() });
      return putFile('data/subscriptions.json', list, f.sha, 'Toestel aangemeld voor meldingen');
    }).then(function () {
      pushInfo.subscribed = true; setSync('ok', 'Meldingen staan aan');
      return reg.showNotification('Meldingen staan aan', { body: 'Je krijgt nu een seintje bij je taken.', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    }).catch(function (e) { setSync('err', e.message || 'Aanmelden mislukt'); });
  }
  function disablePush() {
    var endpoint;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (s) { if (!s) return; endpoint = s.endpoint; return s.unsubscribe(); })
      .then(function () { return token && endpoint ? getFile('data/subscriptions.json') : null; })
      .then(function (f) {
        if (!f) return;
        var list = (f.data || []).filter(function (x) { return x.endpoint !== endpoint; });
        return putFile('data/subscriptions.json', list, f.sha, 'Toestel afgemeld voor meldingen');
      })
      .then(function () { pushInfo.subscribed = false; setSync('ok', 'Meldingen uit op dit toestel'); })
      .catch(function () { setSync('err', 'Afmelden mislukt'); });
  }
  function deviceName() {
    var u = navigator.userAgent;
    return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Toestel';
  }
  function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }

  // ---------- UI ----------
  var view = 'plan', sel = new Date(), editing = null, form = blank();

  function render() {
    var now = new Date();
    var cls = sync.state === 'ok' ? 'sync ok' : sync.state === 'err' ? 'sync err' : 'sync';
    var h = '<h1>Terugkerende taken</h1><p class="sub">' + cap(DAYL[now.getDay()]) + ' ' + now.getDate() + ' ' + MON[now.getMonth()] +
      (sync.msg ? ' <span class="' + cls + '">' + esc(sync.msg) + '</span>' : '') + '</p>';
    h += '<div class="tabs">' + [['plan', 'Planning'], ['beheer', 'Taken beheren'], ['instel', 'Instellingen']].map(function (v) {
      return '<button class="tab' + (view === v[0] ? ' on' : '') + '" data-v="' + v[0] + '">' + v[1] + '</button>';
    }).join('') + '</div>';
    h += view === 'plan' ? renderPlan() : view === 'beheer' ? renderManage() : renderSettings();
    document.getElementById('root').innerHTML = h;
  }

  function renderPlan() {
    var h = '<div class="week">';
    weekDates().forEach(function (d) {
      var n = tasksFor(d).length, dn = (S.done[key(d)] || []).length;
      h += '<button class="day' + (key(d) === key(sel) ? ' sel' : '') + (isToday(d) ? ' today' : '') + '" data-d="' + key(d) + '"><small>' + DAYN[d.getDay()] + '</small><b>' + d.getDate() + '</b><div class="dots">' + (n ? (dn >= n ? '✓' : '•'.repeat(Math.min(n, 4))) : '') + '</div></button>';
    });
    h += '</div>';
    var list = tasksFor(sel), done = S.done[key(sel)] || [];
    h += '<h2>' + (isToday(sel) ? 'Vandaag' : cap(DAYL[sel.getDay()]) + ' ' + sel.getDate() + ' ' + MON[sel.getMonth()]) + '</h2><div class="card">';
    if (!list.length) h += '<div class="empty">Niets gepland voor deze dag.</div>';
    else {
      var c = list.filter(function (t) { return done.indexOf(t.id) > -1; }).length;
      h += '<div class="prog"><div class="bar"><i style="width:' + Math.round(c / list.length * 100) + '%"></i></div><span>' + c + ' van ' + list.length + ' klaar</span></div>';
      var n = new Date(), hm = String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
      list.forEach(function (t) {
        var on = done.indexOf(t.id) > -1, late = !on && isToday(sel) && t.time && t.time < hm;
        h += '<div class="item' + (on ? ' done' : '') + '"><button class="chk' + (on ? ' on' : '') + '" data-t="' + t.id + '" aria-label="Afvinken">' +
          (on ? '<svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 7l3 3 6-7" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
          '</button><span class="name">' + esc(t.name) + '</span>' +
          (t.time ? '<span class="time' + (late ? ' late' : '') + '">' + (notifies(t) ? BELL + ' ' : '') + t.time + '</span>' : '') + '</div>';
      });
    }
    return h + '</div>';
  }

  function renderManage() {
    var h = '<h2>' + (editing ? 'Taak bewerken' : 'Nieuwe taak') + '</h2><div class="card"><form class="form" id="f">';
    h += '<div class="row"><input type="text" id="fn" placeholder="Bijv. Planten water geven" value="' + esc(form.name) + '"><input type="time" id="ft" value="' + esc(form.time) + '" title="Tijd (optioneel)"></div>';
    h += '<div class="row">' + [1, 2, 3, 4, 5, 6, 0].map(function (x) { return '<button type="button" class="dbtn' + (form.days.indexOf(x) > -1 ? ' on' : '') + '" data-fd="' + x + '">' + DAYN[x] + '</button>'; }).join('') + '</div>';
    h += '<div class="row"><button type="button" class="dbtn' + (form.notify ? ' on' : '') + '" id="fnot">' + BELL + ' Melding ' + (form.notify ? 'aan' : 'uit') + '</button><span class="small">' +
      (form.notify && !form.time ? 'Stel een tijd in om een melding te krijgen.' : form.notify ? 'Pushmelding rond de ingestelde tijd.' : '') + '</span></div>';
    h += '<div class="row"><button type="button" class="link" data-preset="1,2,3,4,5">Werkdagen</button><button type="button" class="link" data-preset="0,1,2,3,4,5,6">Elke dag</button><span style="flex:1"></span>' +
      (editing ? '<button type="button" class="link" id="cancel">Annuleren</button>' : '') + '<button class="primary" type="submit">' + (editing ? 'Opslaan' : 'Toevoegen') + '</button></div>';
    h += '</form></div><h2>Alle taken (' + S.tasks.length + ')</h2><div class="card">';
    if (!S.tasks.length) h += '<div class="empty">Nog geen taken. Voeg er hierboven een toe.</div>';
    S.tasks.slice().sort(function (a, b) { return (a.time || '99').localeCompare(b.time || '99'); }).forEach(function (t) {
      h += '<div class="item"><span class="name">' + esc(t.name) + '<br><span class="small">' + daysLabel(t.days) + (t.time ? ' · ' + t.time : '') + (notifies(t) ? ' · ' + BELL : '') + '</span></span>' +
        '<button class="link" data-edit="' + t.id + '">Bewerk</button><button class="del" data-del="' + t.id + '" aria-label="Verwijderen">×</button></div>';
    });
    return h + '</div>';
  }

  function renderSettings() {
    var h = '<h2>Meldingen op dit toestel</h2><div class="card">';
    if (!pushInfo.supported) {
      h += '<p class="p">' + (isIOS() && !isStandalone()
        ? 'Op iPhone werken meldingen alleen als de app op je beginscherm staat. Tik in Safari op <b>Deel</b> → <b>Zet op beginscherm</b> en open de app vanaf daar.'
        : 'Deze browser ondersteunt geen pushmeldingen.') + '</p>';
    } else {
      h += '<p class="p">' + (pushInfo.subscribed ? 'Meldingen staan <b>aan</b> op dit toestel.' : 'Meldingen staan <b>uit</b> op dit toestel.') + '</p>';
      h += '<div class="p row">' + (pushInfo.subscribed
        ? '<button class="primary" id="pushoff">Meldingen uitzetten</button>'
        : '<button class="primary" id="pushon"' + (token ? '' : ' disabled') + '>Meldingen aanzetten</button>' + (token ? '' : '<span class="small">Vul eerst hieronder je token in.</span>')) + '</div>';
    }
    h += '</div><h2>Opslag in GitHub</h2><div class="card"><form class="form" id="tf">';
    h += '<p class="small" style="margin:0">Je taken worden bewaard in <b>' + esc(REPO.owner + '/' + REPO.repo) + '</b> (data/state.json). Om te kunnen opslaan en meldingen aan te zetten heeft de app een GitHub-token nodig. Het token blijft alleen op dit toestel.</p>';
    h += '<div class="row"><input type="password" id="tok" autocomplete="off" placeholder="github_pat_…" value="' + esc(token) + '"><button class="primary" type="submit">Opslaan</button></div>';
    h += '<p class="small" style="margin:0">' + (token ? 'Token ingesteld. <button type="button" class="link" id="tokdel">Verwijderen</button>' : 'Nog geen token ingesteld.') + '</p>';
    h += '</form></div><div class="card"><ol class="p small">' +
      '<li>Ga naar <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → Fine-grained token</a>.</li>' +
      '<li>Repository access: <b>Only select repositories</b> → <b>' + esc(REPO.repo) + '</b>.</li>' +
      '<li>Permissions → Repository → <b>Contents: Read and write</b>.</li>' +
      '<li>Kies een vervaldatum, maak het token aan en plak het hierboven.</li></ol></div>';
    return h;
  }

  function readForm() {
    var n = document.getElementById('fn'), t = document.getElementById('ft');
    if (n) form.name = n.value; if (t) form.time = t.value;
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var ds = b.dataset;
    if (ds.v) { readForm(); view = ds.v; render(); if (view === 'instel') checkSub(); return; }
    if (ds.d) { var p = ds.d.split('-'); sel = new Date(+p[0], +p[1] - 1, +p[2]); render(); return; }
    if (ds.t) {
      var k = key(sel), arr = S.done[k] || (S.done[k] = []), i = arr.indexOf(ds.t);
      if (i > -1) arr.splice(i, 1); else arr.push(ds.t);
      if (!arr.length) delete S.done[k];
      save(); return;
    }
    if (ds.fd !== undefined) { readForm(); var x = +ds.fd, j = form.days.indexOf(x); if (j > -1) form.days.splice(j, 1); else form.days.push(x); render(); return; }
    if (ds.preset) { readForm(); form.days = ds.preset.split(',').map(Number); render(); return; }
    if (ds.edit) {
      var t = S.tasks.filter(function (z) { return z.id === ds.edit; })[0];
      editing = t.id; form = { name: t.name, days: t.days.slice(), time: t.time || '', notify: t.notify !== false }; render(); scrollTo(0, 0); return;
    }
    if (ds.del) {
      var tt = S.tasks.filter(function (z) { return z.id === ds.del; })[0];
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Zeker?'; b.style.fontSize = '13px'; return; }
      S.tasks = S.tasks.filter(function (z) { return z !== tt; });
      if (editing === ds.del) { editing = null; form = blank(); }
      save(); return;
    }
    if (b.id === 'fnot') { readForm(); form.notify = !form.notify; render(); return; }
    if (b.id === 'cancel') { editing = null; form = blank(); render(); return; }
    if (b.id === 'pushon') { enablePush(); return; }
    if (b.id === 'pushoff') { disablePush(); return; }
    if (b.id === 'tokdel') { token = ''; LS.set('rt-token', ''); setSync('idle', 'Token verwijderd'); return; }
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'tf') {
      token = document.getElementById('tok').value.trim(); LS.set('rt-token', token);
      setSync('busy', 'Token controleren…');
      gh('').then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error();
          if (!j.permissions || !j.permissions.push) { setSync('err', 'Token heeft geen schrijfrechten'); return; }
          setSync('ok', 'Token werkt'); return pull();
        });
      }).catch(function () { setSync('err', 'Token werkt niet'); });
      return;
    }
    readForm();
    var name = form.name.trim();
    if (!name) { setSync('err', 'Geef de taak een naam'); return; }
    if (!form.days.length) { setSync('err', 'Kies minstens één dag'); return; }
    if (editing) {
      var t = S.tasks.filter(function (z) { return z.id === editing; })[0];
      t.name = name; t.days = form.days.slice(); t.time = form.time; t.notify = form.notify;
    } else {
      S.tasks.push({ id: 't' + Date.now().toString(36), name: name, days: form.days.slice(), time: form.time, notify: form.notify });
    }
    editing = null; form = blank(); save();
  });

  // ---------- start ----------
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(checkSub).catch(function () {});
  fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (c) { for (var k in c) CFG[k] = c[k]; })
    .catch(function () {})
    .then(pull);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !dirty) { sel = isToday(sel) ? new Date() : sel; pull(); } });
  setInterval(function () { if (view === 'plan') render(); }, 60000);
})();
