// Stuurt pushmeldingen voor taken die nu aan de beurt zijn.
// Draait via .github/workflows/remind.yml. Schrijft data/sent.json en ruimt verlopen toestellen op.
import fs from 'node:fs';
import webpush from 'web-push';

const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n');

const cfg = read('config.json', {});
const privateKey = process.env.VAPID_PRIVATE_KEY;
if (!privateKey) { console.log('VAPID_PRIVATE_KEY ontbreekt nog (repo secret); niets verstuurd.'); process.exit(0); }
webpush.setVapidDetails(cfg.contact || 'mailto:noreply@example.com', cfg.vapidPublicKey, privateKey);

const TEST = process.env.TEST === 'true';
const EARLY = 5;   // minuten vóór de tijd mag al gestuurd worden
const LATE = 90;   // GitHub-planning kan uitlopen; tot zo lang na de tijd nog sturen

const state = read('data/state.json', { tasks: [], done: {} });
let subs = read('data/subscriptions.json', []);
const sent = read('data/sent.json', {});

// Huidige tijd in de ingestelde tijdzone (of NOW_OVERRIDE=YYYY-MM-DDTHH:MM voor tests)
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
const lead = (t) => ([0, 5, 10, 15, 30, 60].includes(t.lead) ? t.lead : 0);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const done = (state.done || {})[now.date] || [];
const sentToday = sent[now.date] || [];
// Een taak hoort bij vandaag als hij herhaalt op deze weekdag, of eenmalig voor deze datum is.
const skipped = ((state.skip || {})[now.date]) || [];
const occursToday = (t) => !skipped.includes(t.id) && (Array.isArray(t.days) && t.days.length ? t.days.includes(now.weekday) : t.date === now.date);
const due = (state.tasks || []).filter((t) =>
  t && typeof t.id === 'string' && typeof t.time === 'string' && /^\d{2}:\d{2}$/.test(t.time) &&
  t.notify !== false && occursToday(t) &&
  !done.includes(t.id) && !sentToday.includes(t.id) &&
  (toMin(t.time) - lead(t)) - now.minutes <= EARLY && now.minutes - (toMin(t.time) - lead(t)) <= LATE);

const messages = TEST
  ? [{ title: 'TaskForce X', body: 'Testmelding: pushmeldingen werken.', tag: 'test' }]
  : due.map((t) => ({
      title: String(t.name || 'Taak').slice(0, 120),
      body: lead(t) ? `Over ${lead(t)} minuten, om ${t.time}` : `Gepland om ${t.time}`,
      tag: `${t.id}-${now.date}`, id: t.id, date: now.date
    }));

console.log(`${now.date} ${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')} (dag ${now.weekday}) — ${messages.length} melding(en), ${subs.length} toestel(len)`);

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromium\.org)\//i;
subs = subs.filter((s) => s && typeof s.endpoint === 'string' && ALLOWED.test(s.endpoint) && s.keys && s.keys.p256dh && s.keys.auth);
const gone = new Set();
let delivered = 0;
for (const msg of messages) {
  for (const s of subs) {
    if (gone.has(s.endpoint)) continue;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600, urgency: 'high' });
      delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) gone.add(s.endpoint);
      console.error(`Fout bij ${s.device || 'toestel'}: ${e.statusCode || ''} ${e.body || e.message}`);
    }
  }
}
console.log(`${delivered} keer afgeleverd`);

let changed = false;
if (!TEST && due.length && subs.length) {
  sent[now.date] = [...sentToday, ...due.map((t) => t.id)];
  changed = true;
}
// opruimen: oude verzendlog en verlopen toestellen
const cutoff = new Date(Date.parse(now.date) - 7 * 864e5).toISOString().slice(0, 10);
for (const k of Object.keys(sent)) if (k < cutoff) { delete sent[k]; changed = true; }
if (changed) write('data/sent.json', sent);
if (gone.size) { subs = subs.filter((s) => !gone.has(s.endpoint)); write('data/subscriptions.json', subs); }
