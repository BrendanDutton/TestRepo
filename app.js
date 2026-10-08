'use strict';

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
// Times: "9:05 am" / "12 pm" (or "09:05" / "12:00" when 24-hour is chosen in Settings).
const use24 = () => typeof state !== 'undefined' && state.clock === '24';
function fmtHM(H, M, hourOnly = false) {
  if (use24()) return `${String(H).padStart(2, '0')}:${String(hourOnly ? 0 : M).padStart(2, '0')}`;
  const h12 = H % 12 || 12, ap = H < 12 ? 'am' : 'pm';
  return hourOnly ? `${h12} ${ap}` : `${h12}:${String(M).padStart(2, '0')} ${ap}`;
}
const fmtTime = (ms) => { const d = new Date(ms); return fmtHM(d.getHours(), d.getMinutes()); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Build a DOM node; text is always set via textContent/append so imported
// calendar data can never inject markup.
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'checked') n.checked = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast'), b = $('#toast-action');
  $('#toast-text').textContent = msg;
  b.hidden = !action;
  b.onclick = action ? () => { action.fn(); t.classList.remove('show'); } : null;
  if (action) b.textContent = action.label;
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
const buzz = (ms = 12) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* unsupported */ } };

// Inline SVG icon from the sprite in index.html.
function ic(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Count a number up/down smoothly (instant with reduced motion).
function tween(el, to, fmt = (v) => String(Math.round(v)), ms = 650) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (reduceMotion.matches || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Fade/slide a text change in.
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (!reduceMotion.matches && el.animate) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
}

// Close a <dialog> with its exit animation.
function closeDlg(d) {
  if (!d.open) return;
  if (reduceMotion.matches) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.classList.remove('closing'); d.close(); }, 190);
}
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) closeDlg(d); });

// Event colour means something: blue = coming up, green = happening now, grey = finished.
function evTone(ev, s, e, now = Date.now()) {
  if (Math.max(e, s + 1) <= now) return 'tone-past';
  if (!ev.allDay && s <= now) return 'tone-now';
  return 'tone-next';
}

/* ---------- state ---------- */
const KEY = 'my-day.v1';

// Ready-made layouts. Each entry is [widget type, size].
const PRESETS = {
  essentials: [['weather', 'full'], ['next', 'half'], ['progress', 'half'], ['schedule', 'full'], ['todo', 'full']],
  planner: [['next', 'half'], ['progress', 'half'], ['schedule', 'full'], ['todo', 'full'], ['habits', 'full'], ['countdown', 'half'], ['focus', 'half'], ['week', 'full']],
  weather: [['weather', 'full'], ['hourly', 'full'], ['daily', 'full'], ['air', 'half'], ['sun', 'half']],
  everything: [['weather', 'full'], ['next', 'half'], ['progress', 'half'], ['hourly', 'full'], ['schedule', 'full'], ['todo', 'full'], ['daily', 'full'], ['habits', 'full'],
    ['air', 'half'], ['sun', 'half'], ['countdown', 'half'], ['focus', 'half'], ['clocks', 'half'], ['dayprog', 'half'], ['notes', 'full'], ['week', 'full']],
};
const PRESET_INFO = [
  ['essentials', 'Essentials', 'Weather, what’s next, calendar and to-dos'],
  ['planner', 'Planner', 'Calendar, to-dos, habits and focus'],
  ['weather', 'Weather', 'Everything about the weather'],
  ['everything', 'Everything', 'Every widget'],
];
const makeLayout = (name) => PRESETS[name].map(([type, size]) => ({ id: uid(), type, size }));

// Starter habits most people find useful (anyone can delete them), plus extra ideas
// offered under "Need ideas?" in the Habits widget.
const DEFAULT_HABITS = ['💧 Drink 8 glasses of water', '🚶 Move for 20 minutes', '📖 Read for 10 minutes', '😴 Get 7–8 hours of sleep'];
const HABIT_IDEAS = ['🧘 Breathe or stretch for 5 minutes', '🥦 Eat fruit or veg with every meal', '🌳 Get outside for some fresh air', '📵 No screens 30 min before bed',
  '🙏 Write down 3 good things', '🦷 Floss', '🛏️ Make your bed', '🧹 10-minute tidy-up', '💊 Take your vitamins', '📞 Message a friend or family member'];

const defaults = () => ({
  tasks: [],      // {id, text, done, doneAt}
  events: [],     // {id, title, start, end, allDay, src, rr}
  history: {},    // dayKey -> tasks completed that day
  unit: /^en-(US|LR|MM)$/.test(navigator.language) ? 'fahrenheit' : 'celsius',
  loc: null,      // {lat, lon, name}
  weather: null,  // {at, key, data}
  air: null,      // {at, key, data}
  installDismissed: false,
  sync: null,     // {url, at}: Google Calendar relay link and last successful sync
  layout: null,   // [{id, type, size}]
  theme: 'auto',
  clock: '12',    // '12' (am/pm) or '24'
  glass: 'liquid', // 'liquid' or 'frosted'
  tipSeen: false,
  habits: [],     // {id, name, days: {dayKey: 1}}
  countdowns: [], // {id, title, date: 'YYYY-MM-DD'}
  clocks: [],     // {id, tz}
  note: '',
  focus: { mode: 'focus', running: false, endsAt: 0, left: 25 * 60000, focusMin: 25, breakMin: 5, done: {} },
});

function load() {
  let s = defaults();
  try { s = { ...s, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* corrupt or blocked storage */ }
  // Tasks finished on an earlier day drop off the list; their count lives on in `history`.
  const today = dayKey(new Date());
  s.tasks = s.tasks.filter((t) => !(t.done && t.doneAt && dayKey(new Date(t.doneAt)) !== today));
  const cutoff = dayKey(addDays(new Date(), -60));
  for (const k of Object.keys(s.history)) if (k < cutoff) delete s.history[k];
  for (const hb of s.habits) for (const k of Object.keys(hb.days || {})) if (k < cutoff) delete hb.days[k];
  for (const k of Object.keys(s.focus.done || {})) if (k < cutoff) delete s.focus.done[k];
  if (!Array.isArray(s.layout)) s.layout = makeLayout('essentials');
  // Give everyone the starter habits once. If they later delete them all, they stay deleted.
  if (!s.habitsSeeded) {
    if (!s.habits.length) s.habits = DEFAULT_HABITS.map((name) => ({ id: uid(), name, days: {} }));
    s.habitsSeeded = true;
  }
  return s;
}
let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

/* ---------- calendar: iCalendar parsing ---------- */
const tzFormatters = new Map();
// Wall-clock time in an IANA zone -> epoch ms. Returns null for zone names the browser doesn't know.
function zonedMs(y, mo, d, hh, mm, ss, tz) {
  try {
    let fmt = tzFormatters.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      tzFormatters.set(tz, fmt);
    }
    const offsetAt = (t) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
    };
    const guess = Date.UTC(y, mo, d, hh, mm, ss);
    return guess - offsetAt(guess - offsetAt(guess));
  } catch { return null; }
}

function icsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)), allDay: false };
  const tz = !allDay && /TZID=([^;:]+)/i.exec(params || '');
  const zoned = tz && zonedMs(+y, +mo - 1, +d, +hh, +mm, +(ss || 0), tz[1].replace(/^"|"$/g, ''));
  if (zoned != null && zoned !== false) return { ms: zoned, allDay };
  // Floating times (or zones the browser can't resolve) are treated as device-local.
  return { ms: new Date(+y, +mo - 1, +d, +(hh || 0), +(mm || 0), +(ss || 0)).getTime(), allDay };
}

function icsDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, hh, mm, ss] = m;
  const ms = (((+w || 0) * 7 + (+d || 0)) * 86400 + (+hh || 0) * 3600 + (+mm || 0) * 60 + (+ss || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function parseRRule(text) {
  const r = {};
  for (const part of text.split(';')) {
    const [k, v] = part.split('=');
    r[k.toUpperCase()] = v;
  }
  const freq = { DAILY: 'd', WEEKLY: 'w', MONTHLY: 'm', YEARLY: 'y' }[r.FREQ];
  if (!freq) return null;
  const out = { freq, interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1) };
  if (r.COUNT) out.count = parseInt(r.COUNT, 10);
  if (r.UNTIL) { const u = icsDate(r.UNTIL, ''); if (u) out.until = u.ms + (u.allDay ? 86400000 : 0); }
  if (r.BYDAY) {
    const days = r.BYDAY.split(',');
    if (freq === 'w') out.byday = days.map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((i) => i >= 0);
    else if (freq === 'm' && days.length === 1) {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(days[0]);
      if (m && m[1]) out.nth = { n: parseInt(m[1], 10), wd: WEEKDAYS.indexOf(m[2]) }; // e.g. 2TU = second Tuesday
    }
  }
  if (r.BYMONTHDAY && freq === 'm' && /^\d+$/.test(r.BYMONTHDAY)) out.monthday = parseInt(r.BYMONTHDAY, 10);
  return out;
}

function parseICS(text, src = 'ics') {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const raw = [];
  let cur = null;
  const unescape = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { ex: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start != null) {
        cur.end = cur.end != null ? cur.end
          : cur.dur != null ? cur.start + cur.dur
          : cur.start + (cur.allDay ? 86400000 : 0);
        raw.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...paramParts] = line.slice(0, i).split(';');
    const params = paramParts.join(';');
    const value = line.slice(i + 1);
    switch (name.toUpperCase()) {
      case 'SUMMARY': cur.title = unescape(value).slice(0, 200); break;
      case 'UID': cur.uid = value.trim(); break;
      case 'STATUS': cur.cancelled = value.trim().toUpperCase() === 'CANCELLED'; break;
      case 'DTSTART': { const d = icsDate(value, params); if (d) { cur.start = d.ms; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = icsDate(value, params); if (d) cur.end = d.ms; break; }
      case 'DURATION': cur.dur = icsDuration(value); break;
      case 'RRULE': cur.rr = parseRRule(value); break;
      case 'RECURRENCE-ID': { const d = icsDate(value, params); if (d) cur.rid = d.ms; break; }
      case 'EXDATE':
        for (const v of value.split(',')) { const d = icsDate(v, params); if (d) cur.ex.push(d.ms); }
        break;
      default:
    }
  }
  // An edited or cancelled single occurrence carries RECURRENCE-ID: hide that slot in the series.
  // (An edited one then shows up as its own standalone event.)
  const masters = new Map();
  for (const e of raw) if (e.rid == null && e.rr && e.uid) masters.set(e.uid, e);
  for (const e of raw) if (e.rid != null && masters.has(e.uid)) masters.get(e.uid).ex.push(e.rid);
  return raw.filter((e) => !e.cancelled).map((e) => ({
    id: uid(), title: e.title || '(No title)', start: e.start, end: e.end, allDay: !!e.allDay,
    src, rr: e.rr || null, ex: e.ex.length ? e.ex : undefined,
  }));
}

// Keep stored data small: drop things that ended more than two weeks ago.
function pruneOld(events) {
  const cutoff = Date.now() - 14 * 86400000;
  return events.filter((e) => (e.rr ? e.rr.until == null || e.rr.until >= cutoff : e.end >= cutoff));
}

/* ---------- calendar: occurrences ---------- */
function nthWeekday(year, month, wd, n) { // day-of-month of the n-th (or -n-th from the end) weekday, or 0
  const last = new Date(year, month + 1, 0).getDate();
  if (n > 0) {
    const day = ((wd - new Date(year, month, 1).getDay() + 7) % 7) + 1 + (n - 1) * 7;
    return day <= last ? day : 0;
  }
  const day = last - ((new Date(year, month + 1, 0).getDay() - wd + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : 0;
}

// Yields [startMs, endMs] for each occurrence of an event, in order. `from` lets long-running
// series skip ahead instead of walking every occurrence since they began.
function* occurrences(ev, from) {
  const dur = Math.max(0, ev.end - ev.start);
  const r = ev.rr;
  if (!r) { yield [ev.start, ev.start + dur]; return; }
  const s = new Date(ev.start);
  let count = 0;
  let i0 = 0;
  if (!r.count && from != null && from > ev.start) {
    const span = from - ev.start, day = 86400000;
    const unit = { d: 1, w: 7, m: 28, y: 365 }[r.freq] * day * r.interval; // months/years: lower bounds, so never overshoot
    i0 = Math.max(0, Math.floor(span / unit) - 1);
  }
  const make = (d) => {
    const t = d.getTime();
    if (r.until != null && t > r.until) return null;
    if (r.count && ++count > r.count) return null;
    return [t, t + dur];
  };
  for (let i = i0; i < i0 + 20000; i++) {
    if (r.freq === 'w') {
      const days = (r.byday && r.byday.length ? [...r.byday] : [s.getDay()]).sort();
      for (const wd of days) {
        const d = new Date(s);
        d.setDate(s.getDate() - s.getDay() + i * 7 * r.interval + wd);
        if (d < s) continue;
        const o = make(d);
        if (!o) return;
        yield o;
      }
    } else {
      let d = new Date(s);
      if (r.freq === 'd') d.setDate(s.getDate() + i * r.interval);
      else if (r.freq === 'm') {
        const y = s.getFullYear(), mo = s.getMonth() + i * r.interval;
        const base = new Date(y, mo, 1);
        const day = r.nth ? nthWeekday(base.getFullYear(), base.getMonth(), r.nth.wd, r.nth.n) : (r.monthday || s.getDate());
        d = new Date(base.getFullYear(), base.getMonth(), day || 99, s.getHours(), s.getMinutes(), s.getSeconds());
        if (!day || d.getMonth() !== base.getMonth() || d < s) continue; // no such day this month
      } else {
        d.setFullYear(s.getFullYear() + i * r.interval);
        if (d.getDate() !== s.getDate()) continue; // Feb 29
      }
      const o = make(d);
      if (!o) return;
      yield o;
    }
  }
}

function eventsOn(date) {
  const from = startOfDay(date).getTime();
  const to = addDays(startOfDay(date), 1).getTime();
  const out = [];
  for (const ev of state.events) {
    for (const [s, e] of occurrences(ev, from)) {
      if (s >= to) break;
      if (ev.ex && ev.ex.includes(s)) continue;
      if (Math.max(e, s + 1) > from) out.push({ ev, s, e });
    }
  }
  return out.sort((a, b) => (b.ev.allDay - a.ev.allDay) || a.s - b.s);
}

/* ---------- small helpers ---------- */
const deg = (v) => `${Math.round(v)}°`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "in 25 min", "in 3 h 10 min"
function rel(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const hr = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hr} h ${mm} min` : `${hr} h`;
}
// Wall-clock time of an Open-Meteo local timestamp ("2026-10-08T06:12"), shown as written.
const fmtWall = (iso, hourOnly = false) => { const d = new Date(iso); return fmtHM(d.getHours(), d.getMinutes(), hourOnly); };
// The time right now in another time zone.
function fmtInZone(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return fmtHM(+p.hour % 24, +p.minute);
}
// Absolute time of an Open-Meteo local timestamp, using the location's UTC offset.
const locMs = (data, iso) => Date.parse(`${iso.length === 10 ? `${iso}T00:00` : iso}Z`) - (data.utc_offset_seconds || 0) * 1000;
const notice = (text, ...extra) => h('div', { class: 'notice' }, h('p', {}, text), ...extra);
const skeleton = () => h('div', { class: 'skel-wrap' }, h('div', { class: 'skel' }), h('div', { class: 'skel short' }));
const springEase = () => getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || 'ease';
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeDlg(b.closest('dialog')));

/* ---------- theme ---------- */
const darkMq = matchMedia('(prefers-color-scheme: dark)');
// Refraction needs SVG filters in backdrop-filter, which only Chromium browsers (Chrome, Brave, Edge…) support.
const canRefract = !!(navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Chromium|Chrome/.test(b.brand)));
function applyGlass() {
  const root = document.documentElement;
  root.classList.toggle('frosted', state.glass === 'frosted');
  root.classList.toggle('liquid', state.glass !== 'frosted' && canRefract);
}
applyGlass();
function applyTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'auto' && darkMq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#090b13' : '#e9ecf8';
}
darkMq.addEventListener('change', applyTheme);
applyTheme();

/* ---------- weather data ---------- */
const WMO = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Icy fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'],
  85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
};
const wmo = (code) => WMO[code] || ['🌡️', 'Unknown'];
const locKey = () => (state.loc ? `${state.loc.lat.toFixed(2)},${state.loc.lon.toFixed(2)},${state.unit}` : '');
let weatherFailed = false, weatherLoading = false, syncing = false, airFailed = false, airLoading = false;
const updateBusy = () => $('#refresh').classList.toggle('spin', weatherLoading || syncing);

function skyFor(code, isDay) {
  if (code >= 95) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 45 || code === 48) return 'fog';
  if (!isDay) return 'night';
  return code <= 1 ? 'clear' : 'cloudy';
}
function currentWeather() {
  const w = state.weather;
  return w && w.key === locKey() ? w.data : null;
}
function applySky() {
  const d = currentWeather();
  if (d) document.body.dataset.sky = skyFor(d.current.weather_code, d.current.is_day);
  else delete document.body.dataset.sky;
}

async function fetchWeather(force = false) {
  if (!state.loc || weatherLoading) return;
  const w = state.weather;
  if (!force && w && w.key === locKey() && Date.now() - w.at < 10 * 60 * 1000) return;
  weatherLoading = true;
  updateBusy();
  const q = new URLSearchParams({
    latitude: state.loc.lat,
    longitude: state.loc.lon,
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max,daylight_duration',
    temperature_unit: state.unit,
    wind_speed_unit: state.unit === 'fahrenheit' ? 'mph' : 'kmh',
    timezone: 'auto',
    forecast_days: 7,
  });
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!res.ok) throw new Error(res.status);
    state.weather = { at: Date.now(), key: locKey(), data: await res.json() };
    weatherFailed = false;
    save();
  } catch {
    weatherFailed = true;
  } finally {
    weatherLoading = false;
    updateBusy();
  }
  applySky();
  refresh('weather', 'hourly', 'daily', 'sun', 'air');
  renderSummary();
}

async function fetchAir(force = false) {
  if (!state.loc || airLoading || !hasWidget('air')) return;
  const a = state.air;
  if (!force && a && a.key === locKey() && Date.now() - a.at < 30 * 60 * 1000) return;
  airLoading = true;
  try {
    const q = new URLSearchParams({ latitude: state.loc.lat, longitude: state.loc.lon, current: 'us_aqi,uv_index', timezone: 'auto' });
    const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
    if (!res.ok) throw new Error(res.status);
    state.air = { at: Date.now(), key: locKey(), data: await res.json() };
    airFailed = false;
    save();
  } catch {
    airFailed = true;
  } finally {
    airLoading = false;
  }
  refresh('air');
}

// Shared "no location / loading / failed" states for weather widgets.
function weatherOr(body) {
  if (!state.loc) {
    body.append(notice('Add your location to see the weather.', h('button', { class: 'primary', onclick: openLocation }, ic('pin', 'ic sm'), 'Set location')));
    return null;
  }
  const d = currentWeather();
  if (!d) body.append(weatherFailed ? notice('Couldn’t load the weather. Check your connection, then tap refresh.') : skeleton());
  return d;
}

/* ---------- location ---------- */
const locDialog = $('#loc-dialog');
function openLocation() {
  $('#loc-results').replaceChildren();
  $('#loc-msg').textContent = '';
  locDialog.showModal();
}
function setLocation(loc) {
  state.loc = loc;
  state.weather = null;
  state.air = null;
  save();
  closeDlg(locDialog);
  applySky();
  refresh('weather', 'hourly', 'daily', 'sun', 'air');
  renderSettings();
  fetchWeather(true);
  fetchAir(true);
}
$('#loc-gps').addEventListener('click', () => {
  const msg = $('#loc-msg');
  if (!navigator.geolocation) { msg.textContent = 'Location isn’t available on this device. Search for a city instead.'; return; }
  msg.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Current location', auto: true }),
    () => { msg.textContent = 'Couldn’t get your location (permission denied?). Search for a city instead.'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
});
$('#loc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#loc-input').value.trim();
  const msg = $('#loc-msg'), list = $('#loc-results');
  if (!name) return;
  list.replaceChildren();
  msg.textContent = 'Searching…';
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: 6, language: 'en' })}`);
    if (!res.ok) throw new Error(res.status);
    const { results = [] } = await res.json();
    msg.textContent = results.length ? '' : 'No matches.';
    for (const r of results) {
      const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
      list.append(h('li', {}, h('button', { type: 'button', onclick: () => setLocation({ lat: r.latitude, lon: r.longitude, name: label }) }, label)));
    }
  } catch {
    msg.textContent = 'Search failed. Check your connection.';
  }
});
$('#loc-close').addEventListener('click', () => closeDlg(locDialog));

// When the location came from GPS, quietly follow you as you move (only if permission was
// already granted, so opening the app never triggers a prompt).
function distKm(a, b) {
  const rad = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
async function refreshAutoLocation() {
  if (!state.loc || !state.loc.auto || !navigator.geolocation || !navigator.permissions) return;
  try {
    if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return;
  } catch { return; }
  await new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (pos) => {
      const next = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (distKm(state.loc, next) > 3) {
        state.loc = { ...state.loc, ...next };
        state.weather = null;
        state.air = null;
        save();
        refresh('weather', 'hourly', 'daily', 'sun', 'air');
      }
      resolve();
    },
    resolve,
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 15 * 60 * 1000 }));
}
const refreshWeather = (force = false) => refreshAutoLocation().then(() => { fetchWeather(force); fetchAir(force); });

/* ---------- tasks ---------- */
let enterId = null;   // task row that should slide in after the next render
let todoTimer = null;

function renderTodosSoon(ms) {
  clearTimeout(todoTimer);
  if (reduceMotion.matches) { refresh('todo'); return; }
  todoTimer = setTimeout(() => refresh('todo'), ms);
}
function afterTaskChange() { refresh('progress', 'week'); renderSummary(); }

function addTask(text) {
  const task = { id: uid(), text, done: false, doneAt: null };
  state.tasks.push(task);
  enterId = task.id;
  save(); refresh('todo'); afterTaskChange();
}
function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const today = dayKey(new Date());
  if (!t.done) {
    t.done = true; t.doneAt = Date.now();
    state.history[today] = (state.history[today] || 0) + 1;
    buzz(14);
  } else {
    if (t.doneAt && dayKey(new Date(t.doneAt)) === today) state.history[today] = Math.max(0, (state.history[today] || 1) - 1);
    t.done = false; t.doneAt = null;
    buzz(8);
  }
  enterId = id;
  save(); renderTodosSoon(520); afterTaskChange();
}
function removeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t && t.done && t.doneAt && dayKey(new Date(t.doneAt)) === dayKey(new Date())) {
    const k = dayKey(new Date());
    state.history[k] = Math.max(0, (state.history[k] || 1) - 1);
  }
  state.tasks = state.tasks.filter((x) => x.id !== id);
  const li = grid.querySelector(`.todo[data-id="${id}"]`);
  if (li && !reduceMotion.matches) {
    li.style.height = `${li.offsetHeight}px`;
    void li.offsetHeight;
    li.classList.add('removing');
  }
  buzz(8);
  save(); renderTodosSoon(300); afterTaskChange();
}

/* ---------- calendar ---------- */
let viewDay = startOfDay(new Date());
let schedDir = 0;
function dayLabel(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long' });
}
let calMode = 'day'; // 'day' or 'week' — not saved, so the app always opens on the day view
function goToDay(d) {
  schedDir = d > viewDay ? 1 : d < viewDay ? -1 : 0;
  viewDay = d;
  morphWidgets('schedule');
  schedDir = 0;
}
function setCalMode(mode, day) {
  if (mode === calMode && !day) return;
  if (day) viewDay = day;
  calMode = mode;
  buzz(8);
  morphWidgets('schedule');
}
const calStep = (dir) => goToDay(addDays(viewDay, dir * (calMode === 'week' ? 7 : 1)));

// Re-render a widget whose height changes: the card springs to its new height and the
// widgets below glide out of (or into) the way instead of jumping.
function morph(sec, item) {
  if (reduceMotion.matches || !sec.isConnected) { updateWidget(sec, item); return; }
  const h0 = sec.getBoundingClientRect().height;
  sec.getAnimations().filter((a) => a.effect?.getKeyframes().some((k) => k.height)).forEach((a) => a.cancel());
  updateWidget(sec, item);
  const h1 = sec.getBoundingClientRect().height;
  if (Math.abs(h1 - h0) < 1) return;
  sec.style.overflow = 'hidden';
  const done = () => { sec.style.overflow = ''; };
  sec.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 650, easing: springEase() }).finished.then(done, done);
}
function morphWidgets(type) {
  for (const item of state.layout) if (item.type === type && nodeOf(item.id)) morph(nodeOf(item.id), item);
  if (sheetItem && sheetItem.type === type) morph($('#ws-body .widget'), sheetItem);
}
function removeEvent(ev) {
  if (ev.rr && !confirm('This repeats. Remove every occurrence?')) return;
  state.events = state.events.filter((x) => x.id !== ev.id);
  save(); refresh('schedule', 'next'); renderSummary();
}

const evDialog = $('#event-dialog');
const evAllDay = $('#ev-allday');
evAllDay.addEventListener('change', () => { $('#ev-times').hidden = evAllDay.checked; });
function openEvent() {
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  const end = new Date(next.getTime() + 3600000);
  $('#ev-title').value = '';
  $('#ev-date').value = dayKey(viewDay);
  $('#ev-start').value = `${pad(next.getHours())}:00`;
  $('#ev-end').value = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  evAllDay.checked = false;
  $('#ev-times').hidden = false;
  evDialog.showModal();
}
$('#ev-cancel').addEventListener('click', () => closeDlg(evDialog));
$('#event-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const date = $('#ev-date').value;
  const allDay = evAllDay.checked;
  let start, end;
  if (allDay) {
    start = new Date(`${date}T00:00`).getTime();
    end = addDays(new Date(start), 1).getTime();
  } else {
    start = new Date(`${date}T${$('#ev-start').value || '09:00'}`).getTime();
    end = new Date(`${date}T${$('#ev-end').value || '10:00'}`).getTime();
    if (!(end > start)) end = start + 3600000;
  }
  if (Number.isNaN(start)) { toast('Pick a valid date'); return; }
  state.events.push({ id: uid(), title: $('#ev-title').value.trim() || '(No title)', start, end, allDay, src: 'manual', rr: null });
  save(); closeDlg(evDialog);
  const day = startOfDay(new Date(start));
  schedDir = day >= viewDay ? 1 : -1;
  viewDay = day;
  refresh('schedule', 'next'); schedDir = 0;
  renderSummary();
  if (!hasWidget('schedule')) toast('Event added');
});

// .ics import (Settings)
$('#import-ics').addEventListener('click', () => $('#ics-file').click());
$('#ics-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large'); return; }
  try {
    const events = parseICS(await file.text(), 'ics');
    if (!events.length) { toast('No events found in that file'); return; }
    state.events = state.events.filter((x) => x.src !== 'ics').concat(events);
    save(); refresh('schedule', 'next'); renderSummary();
    toast(`Imported ${plural(events.length, 'event')}`);
  } catch {
    toast('Couldn’t read that file');
  }
});

/* ---------- Google Calendar sync (via the relay in worker/) ---------- */
let syncError = '';
function syncStatusText() {
  const s = state.sync;
  if (!s) return '';
  const last = s.at ? `Synced ${fmtTime(s.at)}` : 'Not synced yet';
  return syncError ? `${last}. ${syncError}` : last;
}
function renderSyncStatus() {
  for (const el of grid.querySelectorAll('.sync-status')) el.textContent = syncStatusText();
  renderSettings();
}
async function syncCalendar(force = false) {
  const s = state.sync;
  if (!s || !s.url || syncing) return null;
  if (!force && s.at && Date.now() - s.at < 5 * 60 * 1000) return null;
  syncing = true;
  updateBusy();
  try {
    const res = await fetch(s.url, { cache: 'no-store' });
    if (res.status === 401) throw new Error('The access key in the link was rejected.');
    if (!res.ok) throw new Error(`The relay returned an error (${res.status}).`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link didn’t return a calendar.');
    const events = pruneOld(parseICS(text, 'sync'));
    state.events = state.events.filter((x) => x.src !== 'sync').concat(events);
    state.sync = { ...s, at: Date.now() };
    syncError = '';
    save();
    return events.length;
  } catch (e) {
    syncError = e instanceof TypeError ? 'Couldn’t reach the relay (offline?). Showing the last sync.' : `${e.message} Showing the last sync.`;
    return null;
  } finally {
    syncing = false;
    updateBusy();
    refresh('schedule', 'next'); renderSummary(); renderSyncStatus();
  }
}
const syncDialog = $('#sync-dialog');
$('#google-sync').addEventListener('click', () => {
  $('#sync-url').value = state.sync ? state.sync.url : '';
  $('#sync-msg').textContent = '';
  $('#sync-msg').className = 'small-text';
  $('#sync-disconnect').hidden = !state.sync;
  syncDialog.showModal();
});
$('#sync-close').addEventListener('click', () => closeDlg(syncDialog));
$('#sync-disconnect').addEventListener('click', () => {
  state.sync = null;
  state.events = state.events.filter((x) => x.src !== 'sync');
  syncError = '';
  save(); refresh('schedule', 'next'); renderSummary(); renderSyncStatus();
  closeDlg(syncDialog);
  toast('Google Calendar disconnected');
});
$('#sync-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#sync-msg');
  const raw = $('#sync-url').value.trim();
  let url;
  try { url = new URL(raw); } catch { url = null; }
  msg.className = 'small-text';
  if (!url || url.protocol !== 'https:') { msg.textContent = 'Paste the full https:// link, including the ?key=… part.'; msg.classList.add('err'); return; }
  state.sync = { url: url.href, at: 0 };
  msg.textContent = 'Syncing…';
  const n = await syncCalendar(true);
  if (n == null) { msg.textContent = syncError.replace(' Showing the last sync.', ''); msg.classList.add('err'); save(); return; }
  closeDlg(syncDialog);
  toast(`Synced ${plural(n, 'calendar event')}`);
});

/* ---------- focus timer ---------- */
let focusInt = null;
const focusTotal = () => (state.focus.mode === 'focus' ? state.focus.focusMin : state.focus.breakMin) * 60000;
const focusLeft = () => (state.focus.running ? Math.max(0, state.focus.endsAt - Date.now()) : state.focus.left);
function focusToggle() {
  const f = state.focus;
  if (f.running) { f.left = focusLeft(); f.running = false; } else { f.endsAt = Date.now() + f.left; f.running = true; }
  buzz(8); save(); runFocus(); refresh('focus');
}
function focusReset() {
  state.focus.running = false;
  state.focus.left = focusTotal();
  save(); runFocus(); refresh('focus');
}
function focusComplete() {
  const f = state.focus;
  f.running = false;
  if (f.mode === 'focus') {
    const k = dayKey(new Date());
    f.done[k] = (f.done[k] || 0) + 1;
    f.mode = 'break';
    toast(`Focus session done. Take a ${f.breakMin} minute break.`);
  } else {
    f.mode = 'focus';
    toast('Break’s over. Ready to focus again?');
  }
  f.left = focusTotal();
  buzz([90, 60, 90]);
  save(); refresh('focus');
}
function runFocus() {
  clearInterval(focusInt);
  if (!state.focus.running) return;
  focusInt = setInterval(() => {
    if (focusLeft() <= 0) { clearInterval(focusInt); focusComplete(); return; }
    for (const el of grid.querySelectorAll('.w-focus')) paintFocus(el);
  }, 250);
}
const fmtClock = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
function paintFocus(sec) {
  const left = focusLeft(), total = focusTotal();
  const t = sec.querySelector('.focus-time');
  if (t) t.textContent = fmtClock(left);
  const ring = sec.querySelector('.focus-ring .ring-fg');
  if (ring) ring.setAttribute('stroke-dasharray', `${(1 - left / total) * FOCUS_C} ${FOCUS_C}`);
}
const FOCUS_C = 2 * Math.PI * 44;

/* ---------- time zones ---------- */
const FALLBACK_TZ = ['Pacific/Auckland', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/Moscow',
  'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'Atlantic/Reykjavik', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Asia/Seoul', 'Asia/Bangkok'];
const allZones = () => { try { return Intl.supportedValuesOf('timeZone'); } catch { return FALLBACK_TZ; } };
const cityOf = (tz) => tz.split('/').pop().replace(/_/g, ' ');
function zoneOffsetMin(tz, at = Date.now()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at / 60000) * 60000) / 60000);
  } catch { return 0; }
}
const tzDialog = $('#tz-dialog');
function openTz() {
  $('#tz-search').value = '';
  renderTzList();
  tzDialog.showModal();
}
function renderTzList() {
  const q = $('#tz-search').value.trim().toLowerCase();
  const list = $('#tz-list');
  const zones = allZones().filter((z) => !q || z.toLowerCase().replace(/_/g, ' ').includes(q)).slice(0, 60);
  list.replaceChildren(...zones.map((z) => h('li', {}, h('button', { type: 'button', onclick: () => {
    state.clocks.push({ id: uid(), tz: z });
    save(); closeDlg(tzDialog); refresh('clocks');
  } }, h('b', {}, cityOf(z)), h('span', { class: 'muted small-text' }, ` ${z.replace(/_/g, ' ')}`)))));
  if (!zones.length) list.append(h('li', { class: 'empty' }, 'No matching cities.'));
}
$('#tz-search').addEventListener('input', renderTzList);

/* =====================================================================
   Widgets
   Each widget: name, desc (shown in the Add list), icon, chip colour,
   sizes it supports, optional actions() for its header, optional mount()
   that builds parts that must survive refreshes (inputs), and update().
   ===================================================================== */
const W = {};

W.weather = {
  name: 'Weather', desc: 'Temperature and conditions right now', icon: 'sun', chip: 'c-amber', sizes: ['full', 'half'],
  actions: () => [h('button', { class: 'w-act', 'aria-label': 'Change location', title: 'Change location', onclick: openLocation }, ic('pin'))],
  update(body, item, sec) {
    const d = weatherOr(body);
    sec.dataset.sky = d ? skyFor(d.current.weather_code, d.current.is_day) : 'default';
    if (!d) return;
    const c = d.current, day = d.daily;
    const [icon, label] = wmo(c.weather_code);
    body.append(h('div', { class: 'wx-now' },
      h('span', { class: 'wx-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'wx-temp' }, deg(c.temperature_2m)),
      h('div', { class: 'wx-cond' }, h('b', {}, label), h('span', {}, `Feels like ${deg(c.apparent_temperature)}`))));
    if (item.size === 'half') {
      body.append(h('p', { class: 'wx-hl' }, `High ${deg(day.temperature_2m_max[0])} · Low ${deg(day.temperature_2m_min[0])}`));
      return;
    }
    const wind = h('span', {}, `${Math.round(c.wind_speed_10m)}`, h('small', {}, state.unit === 'fahrenheit' ? ' mph' : ' km/h'));
    const stat = (k, v) => h('div', { class: 'wx-stat' }, h('span', {}, k), h('b', {}, v));
    body.append(h('div', { class: 'wx-stats' },
      stat('High', deg(day.temperature_2m_max[0])), stat('Low', deg(day.temperature_2m_min[0])),
      stat('Rain', `${day.precipitation_probability_max[0] ?? 0}%`), stat('Wind', wind)));
    const where = state.loc.name ? `${state.loc.name} · ` : '';
    body.append(h('p', { class: 'wx-place' }, `${where}${weatherFailed ? 'offline, last updated' : 'updated'} ${fmtTime(state.weather.at)}`));
  },
};

W.hourly = {
  name: 'Next hours', desc: 'Hour-by-hour temperature and chance of rain', icon: 'clock', chip: '', sizes: ['full'],
  update(body) {
    const d = weatherOr(body);
    if (!d) return;
    const nowHour = d.current.time.slice(0, 13);
    const start = Math.max(0, d.hourly.time.findIndex((t) => t.slice(0, 13) >= nowHour));
    const strip = h('div', { class: 'hours' });
    for (let i = start; i < Math.min(start + 12, d.hourly.time.length); i++) {
      const p = d.hourly.precipitation_probability[i];
      strip.append(h('div', { class: 'hour' },
        h('span', {}, i === start ? 'Now' : fmtWall(d.hourly.time[i], true)),
        h('span', { class: 'h-ico', 'aria-hidden': 'true' }, wmo(d.hourly.weather_code[i])[0]),
        h('b', {}, deg(d.hourly.temperature_2m[i])),
        h('span', { class: `h-rain${p >= 30 ? ' likely' : ''}`, title: 'Chance of rain' }, `💧${p ?? 0}%`)));
    }
    body.append(strip);
  },
};

W.daily = {
  name: '7-day forecast', desc: 'Highs, lows and rain for the week ahead', icon: 'cloud', chip: '', sizes: ['full'],
  update(body) {
    const d = weatherOr(body);
    if (!d) return;
    const dd = d.daily, n = Math.min(7, dd.time.length);
    const lo = Math.min(...dd.temperature_2m_min.slice(0, n)), hi = Math.max(...dd.temperature_2m_max.slice(0, n));
    const span = Math.max(1, hi - lo);
    const list = h('div', { class: 'days' });
    for (let i = 0; i < n; i++) {
      const min = dd.temperature_2m_min[i], max = dd.temperature_2m_max[i], p = dd.precipitation_probability_max[i] ?? 0;
      const name = i === 0 ? 'Today' : new Date(`${dd.time[i]}T12:00`).toLocaleDateString([], { weekday: 'short' });
      list.append(h('div', { class: 'day-row' },
        h('span', { class: 'day-name' }, name),
        h('span', { class: 'day-ico', 'aria-hidden': 'true' }, wmo(dd.weather_code[i])[0]),
        h('span', { class: 'day-rain' }, p >= 20 ? `${p}%` : ''),
        h('span', { class: 'day-lo' }, deg(min)),
        h('span', { class: 'range', 'aria-hidden': 'true' }, h('i', { style: `left:${((min - lo) / span) * 100}%;right:${100 - ((max - lo) / span) * 100}%` })),
        h('span', { class: 'day-hi' }, deg(max))));
    }
    body.append(list);
  },
};

W.next = {
  name: 'Up next', desc: 'Your next event and how long until it starts', icon: 'clock', chip: 'c-green', sizes: ['half', 'full'],
  update(body) {
    const now = Date.now();
    const todays = eventsOn(new Date()).filter((x) => !x.ev.allDay);
    const current = todays.find((x) => x.s <= now && now < x.e);
    const upcoming = todays.find((x) => x.s > now);
    const pick = current || upcoming;
    if (pick) {
      body.append(h('div', { class: `next ${current ? 'tone-now' : 'tone-next'}` },
        h('p', { class: 'next-when' }, current ? h('span', { class: 'live-dot' }) : null, current ? 'Happening now' : `In ${rel(pick.s - now)}`),
        h('p', { class: 'next-title' }, pick.ev.title),
        h('p', { class: 'next-time' }, current ? `Until ${fmtTime(pick.e)}` : `${fmtTime(pick.s)} – ${fmtTime(pick.e)}`)));
      return;
    }
    const tmr = eventsOn(addDays(new Date(), 1))[0];
    body.append(h('div', { class: 'next' },
      h('p', { class: 'next-title' }, 'Nothing else today'),
      tmr ? h('p', { class: 'next-time' }, `Tomorrow: ${tmr.ev.title}${tmr.ev.allDay ? '' : ` at ${fmtTime(tmr.s)}`}`) : h('p', { class: 'next-time' }, 'Enjoy the free time.')));
  },
};

const RING_C = 2 * Math.PI * 26;
W.progress = {
  name: 'Tasks done', desc: 'How much of today’s to-do list is finished', icon: 'pie', chip: 'c-green', sizes: ['half', 'full'],
  update(body, item, sec) {
    const done = state.tasks.filter((t) => t.done).length, total = state.tasks.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const ring = h('div', { class: 'ring-wrap big' });
    ring.innerHTML = `<svg viewBox="0 0 64 64" class="ring" aria-hidden="true"><circle cx="32" cy="32" r="26" class="ring-bg"/><circle cx="32" cy="32" r="26" class="ring-fg" stroke-dasharray="${((sec._pct || 0) / 100) * RING_C} ${RING_C}"/></svg>`;
    ring.append(h('span', { class: 'ring-text' }, total ? `${done}/${total}` : '–'));
    const left = total - done;
    body.append(h('div', { class: 'prog' }, ring, h('div', { class: 'prog-text' },
      h('p', { class: 'prog-big' }, !total ? 'No tasks' : left ? `${left} left` : 'All done!'),
      h('p', { class: 'muted small-text' }, !total ? 'Add one in To-do' : `${pct}% done today`))));
    sec._pct = pct;
    const fg = ring.querySelector('.ring-fg');
    fg.style.opacity = (sec._pctShown ?? pct) ? '1' : '0'; // a 0-length round cap would draw a stray dot
    sec._pctShown = pct;
    raf2(() => { fg.setAttribute('stroke-dasharray', `${(pct / 100) * RING_C} ${RING_C}`); fg.style.opacity = pct ? '1' : '0'; });
  },
};

const shortDate = (d) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
function weekLabel(start) {
  const diff = Math.round((start - startOfDay(new Date())) / 86400000);
  return diff === 0 ? 'This week' : diff === 7 ? 'Next week' : diff === -7 ? 'Last week' : 'Week';
}
W.schedule = {
  name: 'Calendar', desc: 'Your events by day or for the whole week', icon: 'cal', chip: 'c-violet', sizes: ['full'],
  actions: () => [h('button', { class: 'w-act', 'aria-label': 'Add event', title: 'Add event', onclick: openEvent }, ic('plus'))],
  mount(body) {
    const modeBtn = (v, label) => h('button', { type: 'button', 'data-v': v, role: 'radio', onclick: () => setCalMode(v) }, label);
    body.append(
      h('div', { class: 'seg cal-mode', role: 'radiogroup', 'aria-label': 'Calendar view' }, modeBtn('day', 'Day'), modeBtn('week', 'Week')),
      h('div', { class: 'day-nav' },
        h('button', { class: 'icon-btn small cal-prev', onclick: () => calStep(-1) }, ic('left')),
        h('button', { class: 'day-label', title: 'Back to today', onclick: () => goToDay(startOfDay(new Date())) }, h('b', { class: 'dl-name' }), h('span', { class: 'dl-date muted' })),
        h('button', { class: 'icon-btn small cal-next', onclick: () => calStep(1) }, ic('right'))),
      h('div', { class: 'cal-view' }),
      h('p', { class: 'muted small-text sync-status' }));
  },
  update(body) {
    const week = calMode === 'week';
    for (const b of body.querySelectorAll('.cal-mode button')) { const on = b.dataset.v === calMode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    body.querySelector('.cal-prev').setAttribute('aria-label', week ? 'Previous week' : 'Previous day');
    body.querySelector('.cal-next').setAttribute('aria-label', week ? 'Next week' : 'Next day');
    swapText(body.querySelector('.dl-name'), week ? weekLabel(viewDay) : dayLabel(viewDay));
    const end = addDays(viewDay, 6);
    swapText(body.querySelector('.dl-date'), week ? new Intl.DateTimeFormat([], { day: 'numeric', month: 'short' }).formatRange(viewDay, end) : shortDate(viewDay));
    body.querySelector('.sync-status').textContent = syncStatusText();
    const swap = schedDir > 0 ? ' swap-l' : schedDir < 0 ? ' swap-r' : '';
    const view = body.querySelector('.cal-view');
    const wasWeek = view.dataset.mode === 'week';
    view.dataset.mode = calMode;
    const now = Date.now();

    if (week) {
      const wrap = h('div', { class: `week${swap || (wasWeek ? '' : ' grow')}` });
      for (let i = 0; i < 7; i++) {
        const d = addDays(viewDay, i), items = eventsOn(d), isToday = dayKey(d) === dayKey(new Date());
        const rows = items.length ? items.map(({ ev, s, e }) => h('div', { class: `wk-ev ${evTone(ev, s, e, now)}${!ev.allDay && Math.max(e, s + 1) <= now ? ' past' : ''}` },
          h('span', { class: 'wk-time' }, ev.allDay ? 'All day' : fmtTime(s)), h('span', { class: 'wk-title' }, ev.title)))
          : [h('p', { class: 'wk-free' }, 'Free')];
        wrap.append(h('section', { class: `wk-day${isToday ? ' today' : ''}`, style: `--i:${i}` },
          h('button', { type: 'button', class: 'wk-head', title: 'Open this day', onclick: () => setCalMode('day', d) },
            h('b', {}, i === 0 && isToday ? 'Today' : dayLabel(d)), h('span', { class: 'muted' }, shortDate(d)),
            items.length ? h('span', { class: 'wk-count' }, plural(items.length, 'event')) : null),
          ...rows));
      }
      view.replaceChildren(wrap);
      return;
    }

    const list = h('ul', { class: `list sched${swap}` });
    view.replaceChildren(list);
    const items = eventsOn(viewDay);
    if (!items.length) {
      list.append(h('li', { class: 'empty' }, dayKey(viewDay) === dayKey(new Date()) ? 'Nothing on today.' : 'Nothing on this day.'));
      return;
    }
    items.forEach(({ ev, s, e }, i) => {
      const isNow = !ev.allDay && s <= now && now < e;
      const isPast = !ev.allDay && Math.max(e, s + 1) <= now;
      let sub = null;
      if (isNow) sub = h('div', { class: 's-sub' }, h('span', { class: 'live-dot' }), `Now · until ${fmtTime(e)}`);
      else if (!ev.allDay && e > s) sub = h('div', { class: 's-sub' }, `until ${fmtTime(e)}`);
      list.append(h('li', { class: `${evTone(ev, s, e, now)}${isNow ? ' now' : ''}${isPast ? ' past' : ''}`, style: `--i:${i}` },
        h('div', { class: 's-time' }, ev.allDay ? 'All day' : fmtTime(s)),
        h('div', { class: 's-body' }, h('div', { class: 's-title' }, ev.title), sub),
        h('button', { class: 'x-btn', 'aria-label': `Remove ${ev.title}`, onclick: () => removeEvent(ev) }, ic('x'))));
    });
  },
};

W.todo = {
  name: 'To-do', desc: 'Your task list', icon: 'check', chip: 'c-green', sizes: ['full'],
  actions: () => [h('span', { class: 'w-count muted small-text' })],
  mount(body) {
    const input = h('input', { type: 'text', placeholder: 'Add a task', 'aria-label': 'New task', maxlength: '200', enterkeyhint: 'done' });
    body.append(
      h('form', { class: 'add-row', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ''; addTask(v); } },
        input, h('button', { type: 'submit', class: 'primary', 'aria-label': 'Add task' }, ic('plus'))),
      h('ul', { class: 'list todo-list' }));
  },
  update(body, item, sec) {
    clearTimeout(todoTimer);
    const list = body.querySelector('.todo-list');
    list.replaceChildren();
    const open = state.tasks.filter((t) => !t.done), done = state.tasks.filter((t) => t.done);
    const count = sec.querySelector('.w-count');
    if (count) count.textContent = state.tasks.length ? `${open.length} left` : '';
    if (!state.tasks.length) list.append(h('li', { class: 'empty' }, 'Nothing to do yet.'));
    else if (!open.length) list.append(h('li', { class: 'empty' }, '🎉 All done. Nice work!'));
    const row = (t) => h('li', { class: `todo${t.done ? ' done' : ''}${t.id === enterId ? ' enter' : ''}`, 'data-id': t.id },
      h('label', {},
        h('input', { type: 'checkbox', class: 'cb', checked: t.done, onchange: () => toggleTask(t.id) }),
        h('span', { class: 'box' }, ic('check')),
        h('span', { class: 't' }, t.text)),
      h('button', { class: 'x-btn', 'aria-label': `Delete ${t.text}`, onclick: () => removeTask(t.id) }, ic('x')));
    open.forEach((t) => list.append(row(t)));
    if (done.length) {
      list.append(h('li', { class: 'sep' }, 'Done today'));
      done.forEach((t) => list.append(row(t)));
    }
    enterId = null;
  },
};

W.week = {
  name: 'This week', desc: 'Tasks you’ve finished each day', icon: 'bars', chip: 'c-violet', sizes: ['full'],
  update(body, item, sec) {
    const wrap = h('div', { class: 'bars', role: 'img', 'aria-label': 'Tasks completed per day over the last 7 days' });
    const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i - 6));
    const counts = days.map((d) => state.history[dayKey(d)] || 0);
    const max = Math.max(1, ...counts);
    days.forEach((d, i) => {
      wrap.append(h('div', { class: `bar${i === 6 ? ' today' : ''}`, style: `--h:${Math.max(4, (counts[i] / max) * 72)}px;--k:${i}` },
        h('b', {}, counts[i] || ''), h('i'), h('span', {}, d.toLocaleDateString([], { weekday: 'short' }).slice(0, 3))));
    });
    body.append(wrap);
    if (sec._grown) wrap.classList.add('go', 'still');
    else { sec._grown = true; raf2(() => wrap.classList.add('go')); }
  },
};

function habitStreak(hb) {
  let n = 0, d = new Date();
  if (!hb.days[dayKey(d)]) d = addDays(d, -1);
  while (hb.days[dayKey(d)]) { n++; d = addDays(d, -1); }
  return n;
}
W.habits = {
  name: 'Habits', desc: 'Tick off daily habits and build a streak', icon: 'star', chip: 'c-amber', sizes: ['full'],
  mount(body) {
    const input = h('input', { type: 'text', placeholder: 'New habit, e.g. Drink water', 'aria-label': 'New habit', maxlength: '60', enterkeyhint: 'done' });
    body.append(h('ul', { class: 'list habit-list' }),
      h('form', { class: 'add-row', autocomplete: 'off', onsubmit: (e) => {
        e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = '';
        state.habits.push({ id: uid(), name: v, days: {} }); save(); refresh('habits');
      } }, input, h('button', { type: 'submit', class: 'primary', 'aria-label': 'Add habit' }, ic('plus'))),
      h('button', { type: 'button', class: 'ideas-btn', 'aria-expanded': 'false', onclick: (e) => {
        const box = body.querySelector('.habit-ideas'), open = box.hidden;
        box.hidden = !open;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.lastChild.textContent = open ? 'Hide ideas' : 'Need ideas?';
      } }, ic('star', 'ic sm'), h('span', {}, 'Need ideas?')),
      h('div', { class: 'habit-ideas', hidden: true }));
  },
  update(body) {
    // Suggestions you don't already have; tap one to add it.
    const have = new Set(state.habits.map((x) => x.name.toLowerCase()));
    const ideas = [...DEFAULT_HABITS, ...HABIT_IDEAS].filter((n) => !have.has(n.toLowerCase()));
    body.querySelector('.habit-ideas').replaceChildren(...ideas.map((name) => h('button', { type: 'button', class: 'idea', onclick: () => {
      state.habits.push({ id: uid(), name, days: {} }); buzz(8); save(); refresh('habits');
    } }, ic('plus', 'ic sm'), name)));
    body.querySelector('.ideas-btn').hidden = !ideas.length;
    if (!ideas.length) body.querySelector('.habit-ideas').hidden = true;

    const list = body.querySelector('.habit-list');
    list.replaceChildren();
    if (!state.habits.length) { list.append(h('li', { class: 'empty' }, 'Add a habit you want to do every day, or tap “Need ideas?”.')); return; }
    const today = dayKey(new Date());
    for (const hb of state.habits) {
      const doneToday = !!hb.days[today];
      const dots = h('span', { class: 'dots', 'aria-hidden': 'true' });
      for (let i = 6; i >= 0; i--) dots.append(h('i', { class: hb.days[dayKey(addDays(new Date(), -i))] ? 'on' : '' }));
      const streak = habitStreak(hb);
      list.append(h('li', { class: `habit${doneToday ? ' done' : ''}` },
        h('button', { class: 'habit-btn', 'aria-pressed': String(doneToday), 'aria-label': `${hb.name}: ${doneToday ? 'done today' : 'not done yet'}`, onclick: () => {
          if (hb.days[today]) delete hb.days[today]; else { hb.days[today] = 1; buzz(14); }
          save(); refresh('habits');
        } }, ic('check')),
        h('div', { class: 'habit-body' }, h('span', { class: 'habit-name' }, hb.name), dots),
        streak ? h('span', { class: 'streak', title: `${plural(streak, 'day')} in a row` }, `🔥 ${streak}`) : null,
        h('button', { class: 'x-btn', 'aria-label': `Delete ${hb.name}`, onclick: () => { state.habits = state.habits.filter((x) => x !== hb); save(); refresh('habits'); } }, ic('x'))));
    }
  },
};

const AQI = [[50, 'Good', '#2fbf71'], [100, 'Moderate', '#e3b506'], [150, 'Unhealthy for some', '#f08a24'], [200, 'Unhealthy', '#e5484d'], [300, 'Very unhealthy', '#9d4edd'], [Infinity, 'Hazardous', '#7f1d1d']];
const uvLabel = (u) => (u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme');
W.air = {
  name: 'Air & UV', desc: 'Air quality and how strong the sun is', icon: 'leaf', chip: 'c-green', sizes: ['half', 'full'],
  update(body) {
    if (!state.loc) { weatherOr(body); return; }
    const a = state.air && state.air.key === locKey() ? state.air.data : null;
    if (!a) { body.append(airFailed ? notice('Couldn’t load air quality.') : skeleton()); if (!airLoading) fetchAir(); return; }
    const aqi = Math.round(a.current.us_aqi ?? 0);
    const [, label, color] = AQI.find(([max]) => aqi <= max);
    const uv = a.current.uv_index ?? 0;
    const w = currentWeather();
    const uvMax = w ? w.daily.uv_index_max[0] : null;
    body.append(h('div', { class: 'air' },
      h('p', { class: 'air-big' }, h('span', { class: 'aqi-dot', style: `--c:${color}` }), `${aqi}`, h('small', {}, ' AQI')),
      h('p', { class: 'air-label' }, `Air: ${label}`),
      h('p', { class: 'muted small-text' }, `UV ${Math.round(uv)} · ${uvLabel(uv)}${uvMax != null ? ` (max ${Math.round(uvMax)})` : ''}`)));
  },
};

W.sun = {
  name: 'Sunrise & sunset', desc: 'Daylight times and how much is left', icon: 'sunrise', chip: 'c-amber', sizes: ['half', 'full'],
  update(body) {
    const d = weatherOr(body);
    if (!d) return;
    const now = Date.now();
    const rise = locMs(d, d.daily.sunrise[0]), set = locMs(d, d.daily.sunset[0]);
    const riseNext = d.daily.sunrise[1] ? locMs(d, d.daily.sunrise[1]) : rise + 86400000;
    let line, f = null;
    if (now < rise) line = `Sunrise in ${rel(rise - now)}`;
    else if (now < set) { line = `${rel(set - now)} of daylight left`; f = (now - rise) / (set - rise); }
    else line = `Sunrise in ${rel(riseNext - now)}`;
    const Wd = 140, Hh = 54, rx = Wd / 2 - 8, ry = Hh - 10;
    const svg = `<svg viewBox="0 0 ${Wd} ${Hh + 6}" class="sun-arc" aria-hidden="true"><path d="M8 ${Hh} A ${rx} ${ry} 0 0 1 ${Wd - 8} ${Hh}" class="arc"/><line x1="2" y1="${Hh}" x2="${Wd - 2}" y2="${Hh}" class="horizon"/>${f == null ? '' : `<circle cx="${(Wd / 2 + rx * Math.cos(Math.PI * (1 - f))).toFixed(1)}" cy="${(Hh - ry * Math.sin(Math.PI * (1 - f))).toFixed(1)}" r="6" class="sun-dot"/>`}</svg>`;
    const art = h('div', { class: 'sun-art' });
    art.innerHTML = svg;
    const len = d.daily.daylight_duration ? d.daily.daylight_duration[0] * 1000 : set - rise;
    body.append(art, h('div', { class: 'sun-times' },
      h('span', {}, h('small', { class: 'muted' }, 'Sunrise'), h('b', {}, fmtWall(d.daily.sunrise[0]))),
      h('span', {}, h('small', { class: 'muted' }, 'Sunset'), h('b', {}, fmtWall(d.daily.sunset[0])))),
      h('p', { class: 'sun-line' }, line),
      h('p', { class: 'muted small-text' }, `${rel(len)} of daylight today`));
  },
};

W.clocks = {
  name: 'World clocks', desc: 'The time in other cities', icon: 'globe', chip: '', sizes: ['half', 'full'],
  actions: () => [h('button', { class: 'w-act', 'aria-label': 'Add a city', title: 'Add a city', onclick: openTz }, ic('plus'))],
  update(body) {
    if (!state.clocks.length) { body.append(notice('See the time anywhere.', h('button', { class: 'primary', onclick: openTz }, ic('plus', 'ic sm'), 'Add a city'))); return; }
    const now = Date.now(), localOff = -new Date().getTimezoneOffset(), today = new Date().toLocaleDateString('en-CA');
    const list = h('ul', { class: 'list clock-list' });
    for (const c of state.clocks) {
      const diff = (zoneOffsetMin(c.tz, now) - localOff) / 60;
      const theirDay = new Date(now).toLocaleDateString('en-CA', { timeZone: c.tz });
      const dayWord = theirDay === today ? 'Today' : theirDay > today ? 'Tomorrow' : 'Yesterday';
      const diffTxt = diff === 0 ? 'Same time' : `${diff > 0 ? '+' : '−'}${Math.abs(diff) % 1 ? Math.abs(diff).toFixed(1) : Math.abs(diff)}\u00a0h`;
      list.append(h('li', {},
        h('div', { class: 'clock-body' }, h('span', { class: 'clock-city' }, cityOf(c.tz)), h('span', { class: 'muted small-text' }, `${dayWord}, ${diffTxt}`)),
        h('span', { class: 'clock-time' }, fmtInZone(now, c.tz)),
        h('button', { class: 'x-btn', 'aria-label': `Remove ${cityOf(c.tz)}`, onclick: () => { state.clocks = state.clocks.filter((x) => x !== c); save(); refresh('clocks'); } }, ic('x'))));
    }
    body.append(list);
  },
};

function daysUntil(date) { return Math.round((new Date(`${date}T00:00`) - startOfDay(new Date())) / 86400000); }
const cdWords = (n) => (n === 0 ? ['Today', ''] : n === 1 ? ['1', 'day'] : n > 1 ? [String(n), 'days'] : [String(-n), `day${n === -1 ? '' : 's'} ago`]);
W.countdown = {
  name: 'Countdowns', desc: 'Days until birthdays, trips or deadlines', icon: 'flag', chip: 'c-rose', sizes: ['half', 'full'],
  actions: (item) => [h('button', { class: 'w-act', 'aria-label': 'Add a countdown', title: 'Add a countdown', onclick: (e) => {
    const form = e.currentTarget.closest('.widget').querySelector('.cd-form');
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input').focus();
  } }, ic('plus'))],
  mount(body) {
    const title = h('input', { type: 'text', placeholder: 'What for? e.g. Holiday', 'aria-label': 'Countdown name', maxlength: '60' });
    const date = h('input', { type: 'date', 'aria-label': 'Date', min: dayKey(new Date()) });
    body.append(h('div', { class: 'cd-list' }),
      h('form', { class: 'cd-form', hidden: true, autocomplete: 'off', onsubmit: (e) => {
        e.preventDefault();
        if (!title.value.trim() || !date.value) { toast('Add a name and a date'); return; }
        state.countdowns.push({ id: uid(), title: title.value.trim(), date: date.value });
        title.value = ''; date.value = ''; e.currentTarget.hidden = true;
        save(); refresh('countdown');
      } }, title, date, h('button', { type: 'submit', class: 'primary' }, 'Add')));
  },
  update(body, item) {
    const list = body.querySelector('.cd-list');
    list.replaceChildren();
    const items = [...state.countdowns].sort((a, b) => a.date.localeCompare(b.date));
    const upcoming = items.filter((c) => daysUntil(c.date) >= 0);
    if (!items.length) { list.append(h('p', { class: 'empty' }, 'Tap + to count down to something.')); return; }
    if (item.size === 'half') {
      const c = upcoming[0] || items[items.length - 1];
      const [big, unit] = cdWords(daysUntil(c.date));
      list.append(h('div', { class: 'cd-hero' }, h('p', { class: 'cd-big' }, big, unit ? h('small', {}, ` ${unit}`) : null), h('p', { class: 'cd-title' }, c.title),
        upcoming.length > 1 ? h('p', { class: 'muted small-text' }, `+${upcoming.length - 1} more`) : null));
      return;
    }
    const ul = h('ul', { class: 'list' });
    for (const c of items) {
      const n = daysUntil(c.date);
      const [big, unit] = cdWords(n);
      ul.append(h('li', { class: n < 0 ? 'past' : '' },
        h('span', { class: 'cd-num' }, big, unit ? h('small', {}, unit) : null),
        h('div', { class: 's-body' }, h('div', { class: 's-title' }, c.title), h('div', { class: 's-sub' }, new Date(`${c.date}T12:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))),
        h('button', { class: 'x-btn', 'aria-label': `Delete ${c.title}`, onclick: () => { state.countdowns = state.countdowns.filter((x) => x !== c); save(); refresh('countdown'); } }, ic('x'))));
    }
    list.append(ul);
  },
};

let noteTimer = null;
W.notes = {
  name: 'Notes', desc: 'A quick place to jot things down', icon: 'note', chip: 'c-amber', sizes: ['full', 'half'],
  mount(body) {
    const ta = h('textarea', { class: 'note-area', placeholder: 'Jot something down…', 'aria-label': 'Notes', rows: '3' });
    ta.value = state.note;
    const status = h('p', { class: 'note-status muted small-text', 'aria-live': 'polite' }, '');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 420)}px`; };
    ta.addEventListener('input', () => {
      state.note = ta.value; grow();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { save(); status.textContent = 'Saved'; setTimeout(() => { status.textContent = ''; }, 1400); }, 400);
    });
    body.append(ta, status);
    raf2(grow);
  },
  update(body) {
    const ta = body.querySelector('.note-area');
    if (document.activeElement !== ta && ta.value !== state.note) ta.value = state.note;
  },
};

W.focus = {
  name: 'Focus timer', desc: '25-minute focus sessions with short breaks', icon: 'timer', chip: 'c-rose', sizes: ['half', 'full'],
  update(body, item, sec) {
    const f = state.focus;
    const ring = h('div', { class: 'focus-ring' });
    ring.innerHTML = `<svg viewBox="0 0 100 100" class="ring" aria-hidden="true"><circle cx="50" cy="50" r="44" class="ring-bg"/><circle cx="50" cy="50" r="44" class="ring-fg" stroke-dasharray="0 ${FOCUS_C}"/></svg>`;
    ring.append(h('div', { class: 'focus-face' }, h('span', { class: 'focus-time' }, fmtClock(focusLeft())), h('span', { class: 'focus-mode' }, f.mode === 'focus' ? 'Focus' : 'Break')));
    const sessions = f.done[dayKey(new Date())] || 0;
    body.append(h('div', { class: 'focus' }, ring,
      h('div', { class: 'focus-side' },
        h('div', { class: 'focus-btns' },
          h('button', { class: 'primary', onclick: focusToggle, 'aria-label': f.running ? 'Pause' : 'Start' }, ic(f.running ? 'pause' : 'play', 'ic sm'), f.running ? 'Pause' : 'Start'),
          h('button', { onclick: focusReset, 'aria-label': 'Reset timer' }, ic('refresh', 'ic sm'))),
        h('p', { class: 'muted small-text' }, sessions ? `${plural(sessions, 'session')} today` : 'No sessions yet today'))));
    raf2(() => paintFocus(sec));
  },
};

W.dayprog = {
  name: 'Time left', desc: 'How far through the day, week, month and year you are', icon: 'hourglass', chip: '', sizes: ['half', 'full'],
  update(body) {
    const now = new Date(), sod = startOfDay(now), dayF = (now - sod) / 86400000;
    const wd = (now.getDay() + 6) % 7;
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const soy = new Date(now.getFullYear(), 0, 1), diy = (new Date(now.getFullYear() + 1, 0, 1) - soy) / 86400000;
    const rows = [['Day', dayF], ['Week', (wd + dayF) / 7], ['Month', (now.getDate() - 1 + dayF) / dim], ['Year', (now - soy) / 86400000 / diy]];
    body.append(h('div', { class: 'tprog' }, ...rows.map(([k, v]) => h('div', { class: 'tp-row' },
      h('span', { class: 'tp-k' }, k), h('span', { class: 'tp-bar' }, h('i', { style: `width:${(v * 100).toFixed(1)}%` })), h('span', { class: 'tp-v' }, `${Math.floor(v * 100)}%`)))));
  },
};

// Tapping these cards takes you to a related widget.
const LINKS = { next: 'schedule', progress: 'todo' };
const ORDER = ['weather', 'next', 'progress', 'schedule', 'todo', 'hourly', 'daily', 'habits', 'air', 'sun', 'countdown', 'focus', 'clocks', 'notes', 'dayprog', 'week'];
state.layout = state.layout.filter((i) => W[i.type] && W[i.type].sizes.includes(i.size));
const hasWidget = (type) => state.layout.some((i) => i.type === type);

/* ---------- rendering & layout editing ---------- */
const grid = $('#grid');
let editing = false;
const nodeOf = (id) => grid.querySelector(`.widget[data-id="${id}"]`);

function widgetEl(item) {
  const def = W[item.type];
  const sec = h('section', { class: `widget card w-${item.type} size-${item.size}`, 'data-id': item.id, 'data-type': item.type, 'aria-label': def.name });
  const ctl = (icon, label, fn, cls = '') => h('button', { type: 'button', class: `w-ctl ${cls}`, 'aria-label': `${label} ${def.name}`, title: label, onclick: fn }, ic(icon));
  const grip = h('button', { type: 'button', class: 'w-ctl w-grip', 'aria-label': `Drag to move ${def.name}`, title: 'Drag to move' }, ic('grip'));
  grip.addEventListener('pointerdown', (e) => startDrag(e, sec));
  sec.append(
    h('div', { class: 'w-edit' }, h('div', { class: 'w-edit-inner' },
      grip,
      h('span', { class: 'w-edit-name' }, def.name),
      def.sizes.length > 1 ? ctl('resize', item.size === 'full' ? 'Make smaller' : 'Make bigger', () => toggleSize(item.id)) : null,
      ctl('up', 'Move up', () => moveWidget(item.id, -1)),
      ctl('down', 'Move down', () => moveWidget(item.id, 1)),
      ctl('x', 'Remove', () => removeWidget(item.id), 'w-remove'))),
    h('header', { class: 'w-head' },
      h('h2', {}, h('span', { class: `chip sm ${def.chip || ''}` }, ic(def.icon)), h('span', { class: 'w-title' }, def.name)),
      h('div', { class: 'w-actions' }, ...(def.actions ? def.actions(item) : []), LINKS[item.type] ? h('span', { class: 'go-hint', 'aria-hidden': 'true' }, ic('right')) : null)),
    h('div', { class: 'w-body' }));
  if (LINKS[item.type]) {
    const target = LINKS[item.type];
    sec.classList.add('tap-card');
    sec.setAttribute('role', 'link');
    sec.tabIndex = 0;
    sec.setAttribute('aria-label', `${def.name}. Opens ${W[target].name}`);
    const go = (e) => { if (editing || e.target.closest('.w-edit, input, textarea, a, button:not(.tap-card)')) return; goToWidget(target); };
    sec.addEventListener('click', go);
    sec.addEventListener('keydown', (e) => { if (e.target === sec && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(e); } });
  }
  mountWidget(sec, item);
  return sec;
}
function mountWidget(sec, item) {
  const def = W[item.type], body = sec.querySelector('.w-body');
  body.replaceChildren();
  if (def.mount) def.mount(body, item, sec);
  updateWidget(sec, item);
  setInert(sec);
}
function updateWidget(sec, item) {
  const def = W[item.type], body = sec.querySelector('.w-body');
  if (!def.mount) body.replaceChildren();
  def.update(body, item, sec);
}
function setInert(sec) {
  sec.querySelector('.w-body').inert = editing;
  sec.querySelector('.w-actions').inert = editing;
  sec.querySelector('.w-edit').inert = !editing;
}
function refresh(...types) {
  for (const item of state.layout) {
    if (!types.includes(item.type)) continue;
    const sec = nodeOf(item.id);
    if (sec) updateWidget(sec, item);
  }
  if (sheetItem && types.includes(sheetItem.type)) updateWidget($('#ws-body .widget'), sheetItem);
}

/* ---------- moving between widgets ---------- */
let sheetItem = null;
let glide = null;
// Our own eased scroll (smoother and more consistent than the browser's). A touch cancels it.
function smoothScrollTo(y) {
  const max = document.documentElement.scrollHeight - innerHeight;
  const to = Math.max(0, Math.min(max, y)), from = scrollY, dist = to - from;
  cancelAnimationFrame(glide);
  if (reduceMotion.matches || Math.abs(dist) < 2) { scrollTo(0, to); return Promise.resolve(); }
  const dur = Math.min(950, 420 + Math.abs(dist) * 0.32);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const stop = () => { cancelAnimationFrame(glide); removeEventListener('touchstart', stop); removeEventListener('wheel', stop); resolve(); };
    addEventListener('touchstart', stop, { passive: true, once: true });
    addEventListener('wheel', stop, { passive: true, once: true });
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      scrollTo(0, from + dist * ease(p));
      if (p < 1) glide = requestAnimationFrame(step); else stop();
    };
    glide = requestAnimationFrame(step);
  });
}
// A springy "here I am" bounce plus a soft glow.
function bounce(el) {
  if (reduceMotion.matches) return;
  el.animate([{ scale: 1 }, { scale: 1.045, offset: 0.28 }, { scale: 0.985, offset: 0.55 }, { scale: 1.012, offset: 0.78 }, { scale: 1 }], { duration: 900, easing: 'cubic-bezier(.3,.7,.4,1)' });
  el.classList.remove('w-flash'); void el.offsetWidth; el.classList.add('w-flash');
  setTimeout(() => el.classList.remove('w-flash'), 1500);
}
function goToWidget(type) {
  buzz(10);
  const item = state.layout.find((i) => i.type === type);
  if (!item) { openWidgetSheet(type); return; }
  const el = nodeOf(item.id);
  const top = el.getBoundingClientRect().top + scrollY - 14;
  smoothScrollTo(top).then(() => bounce(el));
}
// Not on your screen? Show it in a sheet, with a shortcut to add it.
function openWidgetSheet(type) {
  sheetItem = { id: `sheet-${type}`, type, size: 'full' };
  const el = widgetEl(sheetItem);
  el.classList.add('in-sheet');
  $('#ws-body').replaceChildren(el);
  $('#ws-add').onclick = () => { closeDlg($('#widget-sheet')); addWidget(type); };
  $('#widget-sheet').showModal();
}
$('#widget-sheet').addEventListener('close', () => { sheetItem = null; $('#ws-body').replaceChildren(); });
function renderGrid(animate = false) {
  grid.replaceChildren(...state.layout.map(widgetEl));
  [...grid.children].forEach((el, i) => {
    if (animate && !reduceMotion.matches) { el.classList.add('w-enter'); el.style.setProperty('--i', i); }
    else if (el.getBoundingClientRect().top < innerHeight) { el.classList.add('intro'); el.style.setProperty('--i', i + 1); }
    else { el.classList.add('pending'); revealObs?.observe(el); }
  });
  updateEmpty();
  runFocus();
}
// Cards below the fold fade up once when they first scroll into view, then the animation is removed
// so nothing keeps animating a glass panel later (Android can misdraw those).
const revealObs = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    revealObs.unobserve(e.target);
    e.target.classList.remove('pending');
    if (!reduceMotion.matches) e.target.classList.add('revealed');
  }
}, { rootMargin: '0px 0px -8% 0px' }) : null;
grid.addEventListener('animationend', (e) => {
  if (e.target.parentElement === grid) e.target.classList.remove('intro', 'revealed', 'w-enter', 'w-swap');
});
function updateEmpty() { $('#empty-screen').hidden = state.layout.length > 0; }

// Animate everything in the grid from where it was to where it ends up.
function flip(mutate, skip) {
  const before = new Map([...grid.children].map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reduceMotion.matches) return;
  for (const el of grid.children) {
    const b = before.get(el);
    if (!b || el === skip) continue;
    const a = el.getBoundingClientRect();
    const dx = b.left - a.left, dy = b.top - a.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 650, easing: springEase() });
    }
  }
}
function moveWidget(id, dir) {
  const i = state.layout.findIndex((x) => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= state.layout.length) return;
  const [item] = state.layout.splice(i, 1);
  state.layout.splice(j, 0, item);
  const focused = document.activeElement;
  flip(() => {
    const sec = nodeOf(id);
    grid.insertBefore(sec, dir < 0 ? grid.children[j] : grid.children[j].nextSibling);
  });
  if (focused && focused.isConnected) focused.focus({ preventScroll: true });
  buzz(6); save();
}
function toggleSize(id) {
  const item = state.layout.find((x) => x.id === id);
  const sizes = W[item.type].sizes;
  item.size = sizes[(sizes.indexOf(item.size) + 1) % sizes.length];
  flip(() => {
    const old = nodeOf(id), sec = widgetEl(item);
    if (!reduceMotion.matches) sec.classList.add('w-swap');
    grid.replaceChild(sec, old);
  });
  buzz(6); save(); fetchAir();
}
function removeWidget(id) {
  const idx = state.layout.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [item] = state.layout.splice(idx, 1);
  save();
  const sec = nodeOf(id);
  const done = () => { flip(() => sec.remove()); updateEmpty(); };
  if (reduceMotion.matches) done();
  else sec.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.then(done);
  buzz(8);
  toast(`${W[item.type].name} removed`, { label: 'Undo', fn: () => { state.layout.splice(idx, 0, item); save(); insertWidget(item); } });
}
function insertWidget(item, scroll = false) {
  const idx = state.layout.indexOf(item);
  const sec = widgetEl(item);
  if (!reduceMotion.matches) sec.classList.add('w-enter');
  flip(() => grid.insertBefore(sec, grid.children[idx] || null), sec);
  updateEmpty();
  if (item.type === 'air') fetchAir();
  if (item.type === 'focus') runFocus();
  if (scroll) setTimeout(() => sec.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' }), 60);
}
function addWidget(type) {
  const item = { id: uid(), type, size: W[type].sizes[0] };
  state.layout.push(item);
  save();
  insertWidget(item, true);
  toast(`${W[type].name} added`);
}
function applyPreset(name) {
  const prev = state.layout;
  state.layout = makeLayout(name);
  save();
  renderGrid(true);
  fetchAir();
  window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  toast('Layout changed', { label: 'Undo', fn: () => { state.layout = prev; save(); renderGrid(true); } });
}

/* Drag to reorder (from the grip handle). Positions use layout offsets, so
   neighbours that are mid-animation don't cause jitter. */
let drag = null;
function startDrag(e, sec) {
  if (!editing || (e.button && e.button !== 0)) return;
  e.preventDefault();
  const grip = e.currentTarget;
  const r = sec.getBoundingClientRect();
  drag = { sec, grip, pid: e.pointerId, offX: e.clientX - r.left, offY: e.clientY - r.top, x: e.clientX, y: e.clientY, raf: 0 };
  try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  sec.classList.add('dragging');
  document.body.classList.add('is-dragging');
  buzz(10);
  // Listen on the window: moving the card in the DOM releases pointer capture, and the
  // release must still be caught wherever the finger ends up.
  const onMove = (ev) => { if (!drag || ev.pointerId !== drag.pid) return; drag.x = ev.clientX; drag.y = ev.clientY; dragFrame(); };
  const onEnd = (ev) => {
    if (drag && ev.pointerId !== drag.pid) return;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onEnd);
    removeEventListener('pointercancel', onEnd);
    endDrag();
  };
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onEnd);
  addEventListener('pointercancel', onEnd);
  dragFrame();
  autoScroll();
}
function placeDragged() {
  const { sec } = drag;
  sec.style.transform = 'none';
  const base = sec.getBoundingClientRect();
  sec.style.transform = `translate(${drag.x - drag.offX - base.left}px, ${drag.y - drag.offY - base.top}px) scale(1.03)`;
}
function dragFrame() {
  if (!drag) return;
  placeDragged();
  const g = grid.getBoundingClientRect();
  const px = drag.x - g.left, py = drag.y - g.top;
  const kids = [...grid.children];
  const from = kids.indexOf(drag.sec);
  for (const el of kids) {
    if (el === drag.sec) continue;
    const inside = px >= el.offsetLeft && px <= el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py <= el.offsetTop + el.offsetHeight;
    if (!inside) continue;
    const to = kids.indexOf(el);
    flip(() => grid.insertBefore(drag.sec, to > from ? el.nextSibling : el), drag.sec);
    placeDragged();
    buzz(5);
    break;
  }
}
function autoScroll() {
  if (!drag) return;
  const edge = 90;
  let dy = 0;
  if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 6);
  else if (drag.y > innerHeight - edge - 70) dy = Math.ceil((drag.y - (innerHeight - edge - 70)) / 6);
  if (dy) { window.scrollBy(0, dy); dragFrame(); }
  drag.raf = requestAnimationFrame(autoScroll);
}
function endDrag() {
  if (!drag) return;
  const { sec } = drag;
  cancelAnimationFrame(drag.raf);
  const from = sec.style.transform;
  sec.style.transform = '';
  sec.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  if (!reduceMotion.matches) sec.animate([{ transform: from }, { transform: 'none' }], { duration: 600, easing: springEase() });
  const byId = new Map(state.layout.map((x) => [x.id, x]));
  state.layout = [...grid.children].map((el) => byId.get(el.dataset.id)).filter(Boolean);
  drag = null;
  save();
}

function setEditing(on) {
  if (editing === on) return;
  editing = on;
  document.body.classList.toggle('editing', on);
  $('#editbar').hidden = !on;
  for (const sec of grid.children) setInert(sec);
  setDock(on ? 'edit' : 'home');
  $('#dock-edit span').textContent = on ? 'Done' : 'Customize';
  if (on) {
    if (!state.tipSeen) { state.tipSeen = true; save(); }
    $('#tip').hidden = true;
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  buzz(8);
}
$('#edit-done').addEventListener('click', () => setEditing(false));
$('#edit-add').addEventListener('click', openAdd);
$('#edit-settings').addEventListener('click', openSettings);
$('#empty-add').addEventListener('click', openAdd);

/* ---------- Add widget sheet ---------- */
const addDialog = $('#add-dialog');
function openAdd() {
  $('#presets').replaceChildren(...PRESET_INFO.map(([key, name, desc]) => h('button', { type: 'button', class: 'preset', onclick: () => { closeDlg(addDialog); applyPreset(key); } },
    h('b', {}, name), h('span', {}, desc))));
  $('#widget-list').replaceChildren(...ORDER.map((type) => {
    const def = W[type], on = hasWidget(type);
    return h('li', {},
      h('span', { class: `chip ${def.chip || ''}` }, ic(def.icon)),
      h('div', { class: 'wl-text' }, h('b', {}, def.name), h('span', {}, def.desc)),
      on ? h('span', { class: 'wl-on' }, ic('check', 'ic sm'), 'Added')
        : h('button', { type: 'button', class: 'primary', 'aria-label': `Add ${def.name}`, onclick: () => { closeDlg(addDialog); addWidget(type); } }, 'Add'));
  }));
  addDialog.showModal();
}

/* ---------- Settings ---------- */
const settingsDialog = $('#settings-dialog');
function renderSettings() {
  for (const [id, val] of [['#set-unit', state.unit], ['#set-theme', state.theme], ['#set-clock', state.clock], ['#set-glass', state.glass]]) {
    for (const b of $(id).children) { const on = b.dataset.v === val; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  }
  $('#set-loc').textContent = state.loc ? state.loc.name || 'Set' : 'Not set';
  $('#set-sync').textContent = state.sync ? syncStatusText() : 'Not connected';
  $('#google-sync').lastChild.textContent = state.sync ? 'Change' : 'Set up';
}
function openSettings() { renderSettings(); settingsDialog.showModal(); }
$('#set-unit').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === state.unit) return;
  state.unit = v; save(); renderSettings();
  refresh('weather', 'hourly', 'daily', 'sun', 'air'); renderSummary();
  fetchWeather(true);
});
$('#set-glass').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === state.glass) return;
  state.glass = v; save(); applyGlass(); renderSettings();
});
$('#set-clock').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === state.clock) return;
  state.clock = v; save(); renderSettings();
  refresh(...ORDER); renderSummary(); renderSyncStatus();
});
$('#set-theme').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  state.theme = v; save(); applyTheme(); renderSettings();
});
$('#set-loc-btn').addEventListener('click', () => { closeDlg(settingsDialog); openLocation(); });
$('#set-reset').addEventListener('click', () => { closeDlg(settingsDialog); applyPreset('essentials'); });

/* ---------- Quick add ---------- */
const quickDialog = $('#quick-dialog');
$('#quick-task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#quick-task'), v = input.value.trim();
  if (!v) return;
  input.value = '';
  addTask(v);
  closeDlg(quickDialog);
  toast(hasWidget('todo') ? 'Task added' : 'Task added. Add the To-do widget to see your list.');
});
$('#quick-event').addEventListener('click', () => { closeDlg(quickDialog); openEvent(); });
$('#quick-widget').addEventListener('click', () => { closeDlg(quickDialog); openAdd(); });
$('#quick-edit').addEventListener('click', () => { closeDlg(quickDialog); setEditing(true); });
$('#quick-settings').addEventListener('click', () => { closeDlg(quickDialog); openSettings(); });

/* ---------- Dock ---------- */
const dock = $('#dock');
const dockPill = dock.querySelector('.dock-pill');
function setDock(which) {
  const btn = which === 'edit' ? $('#dock-edit') : $('#dock-home');
  dockPill.style.setProperty('--x', `${btn.offsetLeft}px`);
  dockPill.style.setProperty('--w', `${btn.offsetWidth}px`);
  $('#dock-home').classList.toggle('on', which !== 'edit');
  $('#dock-edit').classList.toggle('on', which === 'edit');
}
$('#dock-home').addEventListener('click', () => { buzz(6); window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' }); });
$('#dock-add').addEventListener('click', () => { buzz(6); $('#quick-task').value = ''; quickDialog.showModal(); });
$('#dock-edit').addEventListener('click', () => setEditing(!editing));
dock.addEventListener('pointerdown', () => dock.classList.add('press'));
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) dock.addEventListener(ev, () => dock.classList.remove('press'));
addEventListener('resize', () => setDock(editing ? 'edit' : 'home'));
addEventListener('load', () => setDock(editing ? 'edit' : 'home'));
// Low-end phones skip the expensive blur and use solid frosted panels instead.
if ((navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2)) document.documentElement.classList.add('lite');

/* ---------- header ---------- */
function renderHeader() {
  const now = new Date(), hr = now.getHours();
  $('#greeting').textContent = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#today-label').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
// One plain sentence that sums up the day.
function renderSummary() {
  const parts = [];
  const d = currentWeather();
  if (d) parts.push(`${wmo(d.current.weather_code)[1]} and ${deg(d.current.temperature_2m)}.`);
  const now = Date.now();
  const todays = eventsOn(new Date());
  const left = todays.filter((x) => x.ev.allDay || x.e > now).length;
  const open = state.tasks.filter((t) => !t.done).length;
  if (left && open) parts.push(`You’ve got ${plural(left, 'event')} and ${plural(open, 'task')} left today.`);
  else if (left) parts.push(`You’ve got ${plural(left, 'event')} left today.`);
  else if (open) parts.push(`You’ve got ${plural(open, 'task')} to do.`);
  else parts.push(todays.length ? 'You’re all done for today.' : 'Nothing planned today.');
  const next = todays.find((x) => !x.ev.allDay && x.s > now);
  if (next && next.s - now <= 90 * 60000) parts.push(`${next.ev.title} starts in ${rel(next.s - now)}.`);
  swapText($('#summary'), parts.join(' '));
}

/* ---------- lifecycle ---------- */
let lastDay = dayKey(new Date());
function tick() {
  const today = dayKey(new Date());
  if (today !== lastDay) { // midnight rollover
    lastDay = today;
    viewDay = startOfDay(new Date());
    state.tasks = load().tasks;
    refresh(...ORDER);
  }
  renderHeader();
  renderSummary();
  refresh('next', 'schedule', 'clocks', 'sun', 'dayprog');
}
$('#refresh').addEventListener('click', () => { toast('Refreshing…'); refreshWeather(true); syncCalendar(true); tick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refreshWeather(); syncCalendar(); if (state.focus.running) runFocus(); } });
addEventListener('online', () => { fetchWeather(true); fetchAir(true); syncCalendar(true); });
setInterval(tick, 60 * 1000);
setInterval(() => { if (!document.hidden) syncCalendar(); }, 15 * 60 * 1000);

// Android install button (Chrome/Edge/Samsung Internet fire this when the app is installable)
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (!state.installDismissed) $('#install').hidden = false;
});
addEventListener('appinstalled', () => { $('#install').hidden = true; });
$('#install-btn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('#install').hidden = true;
});
$('#install-dismiss').addEventListener('click', () => { state.installDismissed = true; save(); $('#install').hidden = true; });
$('#tip-close').addEventListener('click', () => { state.tipSeen = true; save(); $('#tip').hidden = true; });

// A focus session that finished while the app was closed.
if (state.focus.running && focusLeft() <= 0) focusComplete();

applySky();
renderHeader();
renderSummary();
renderGrid();
$('#tip').hidden = state.tipSeen;
setDock('home');
refreshWeather();
syncCalendar();
if (!state.loc && hasWidget('weather')) setTimeout(() => { if (!state.loc && !document.querySelector('dialog[open]')) openLocation(); }, 900);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  // A new version just took over: reload once so the fresh code shows straight away
  // (unless you're in the middle of something).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !editing && !document.querySelector('dialog[open]') && !(document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) location.reload();
  });
}
