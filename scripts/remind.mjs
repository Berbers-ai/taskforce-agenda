// Stuurt pushmeldingen voor taken die nu aan de beurt zijn.
// Leest uit Supabase met de geheime sleutel (repo secret SUPABASE_SECRET_KEY).
// Draait via .github/workflows/remind.yml.
import fs from 'node:fs';
import webpush from 'web-push';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const KEY = process.env.SUPABASE_SECRET_KEY;
const VAPID = process.env.VAPID_PRIVATE_KEY;
if (!KEY || !VAPID || !(cfg.supabaseUrl || process.env.SUPABASE_URL_TEST)) {
  console.log('Nog niet ingesteld (SUPABASE_SECRET_KEY, VAPID_PRIVATE_KEY of supabaseUrl ontbreekt); niets verstuurd.');
  process.exit(0);
}
if (process.env.SUPABASE_URL_TEST) cfg.supabaseUrl = process.env.SUPABASE_URL_TEST;   // alleen voor lokale tests
else if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(cfg.supabaseUrl)) { console.error('Ongeldige supabaseUrl'); process.exit(1); }
webpush.setVapidDetails(cfg.contact || 'mailto:noreply@example.com', cfg.vapidPublicKey, VAPID);

// Supabase REST. Nieuwe sleutels (sb_secret_…) gaan alleen in de apikey-header.
const headers = { apikey: KEY, 'Content-Type': 'application/json' };
if (!KEY.startsWith('sb_')) headers.Authorization = `Bearer ${KEY}`;
async function api(path, opts = {}) {
  const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
  return r.status === 204 || opts.method === 'DELETE' ? null : r.json().catch(() => null);
}

const TEST = process.env.TEST === 'true';
const EARLY = 5;   // minuten vóór het moment mag al gestuurd worden
const LATE = 60;   // als GitHub de run later start: tot zo lang na het moment nog sturen
const LEADS = [0, 5, 10, 15, 30, 60];

function nowParts() {
  if (process.env.NOW_OVERRIDE) {
    const [d, t] = process.env.NOW_OVERRIDE.split('T');
    const [y, m, dd] = d.split('-').map(Number);
    return { date: d, minutes: +t.slice(0, 2) * 60 + +t.slice(3, 5), weekday: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() };
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timeZone || 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (+p.hour % 24) * 60 + +p.minute,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  };
}
const now = nowParts();
const D = now.date;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const lead = (t) => (LEADS.includes(t.lead) ? t.lead : 0);

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromium\.org)\//i;
let subs = (await api('push_subs?select=endpoint,user_id,space_id,p256dh,auth,device'))
  .filter((s) => ALLOWED.test(s.endpoint) && s.p256dh && s.auth);

let jobs = [];
if (TEST) {
  jobs = subs.map((s) => ({ sub: s, msg: { title: 'TaskForce X', body: 'Testmelding: pushmeldingen werken.', tag: 'test' } }));
} else {
  const [tasks, done, skip, sent] = await Promise.all([
    api('tasks?select=id,space_id,name,date,days,time,lead,assignee&notify=is.true&time=not.is.null'),
    api(`task_done?select=task_id&day=eq.${D}`),
    api(`task_skip?select=task_id&day=eq.${D}`),
    api(`sent?select=task_id&day=eq.${D}`)
  ]);
  const doneIds = new Set(done.map((r) => r.task_id));
  const skipIds = new Set(skip.map((r) => r.task_id));
  const sentIds = new Set(sent.map((r) => r.task_id));
  const due = tasks.filter((t) => {
    if (!/^\d{2}:\d{2}$/.test(t.time || '')) return false;
    const today = Array.isArray(t.days) && t.days.length ? t.days.includes(now.weekday) : t.date === D;
    if (!today || doneIds.has(t.id) || skipIds.has(t.id) || sentIds.has(t.id)) return false;
    const at = toMin(t.time) - lead(t);
    return at - now.minutes <= EARLY && now.minutes - at <= LATE;
  });
  for (const t of due) {
    const msg = {
      title: String(t.name).slice(0, 120),
      body: lead(t) ? `Over ${lead(t)} minuten, om ${t.time}` : `Gepland om ${t.time}`,
      tag: `${t.id}-${D}`, id: t.id, date: D
    };
    // Naar de toegewezen persoon, of naar iedereen in de agenda
    for (const s of subs) if (s.space_id === t.space_id && (!t.assignee || t.assignee === s.user_id)) jobs.push({ sub: s, msg, task: t });
  }
  if (due.length) {
    await api('sent', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(due.map((t) => ({ task_id: t.id, day: D }))) });
  }
}

console.log(`${D} ${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')} — ${jobs.length} melding(en), ${subs.length} toestel(len)`);

const gone = new Set();
let delivered = 0;
for (const { sub, msg } of jobs) {
  if (gone.has(sub.endpoint)) continue;
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(msg), { TTL: 3600, urgency: 'high' });
    delivered++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) gone.add(sub.endpoint);
    console.error(`Fout bij ${sub.device || 'toestel'}: ${e.statusCode || ''} ${e.body || e.message}`);
  }
}
console.log(`${delivered} keer afgeleverd`);

// Opruimen: verlopen toestellen en oude verzendlog
for (const ep of gone) await api(`push_subs?endpoint=eq.${encodeURIComponent(ep)}`, { method: 'DELETE' });
const cutoff = new Date(Date.parse(D) - 7 * 864e5).toISOString().slice(0, 10);
await api(`sent?day=lt.${cutoff}`, { method: 'DELETE' });
