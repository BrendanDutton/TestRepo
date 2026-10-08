'use strict';

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
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
  if (!reduceMotion.matches && el.animate) el.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

// Close a <dialog> with its exit animation.
function closeDlg(d) {
  if (!d.open) return;
  if (reduceMotion.matches) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.classList.remove('closing'); d.close(); }, 190);
}
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) closeDlg(d); });

// Hue from a string, so each event keeps a stable colour.
function evColor(title) {
  let n = 0;
  for (const ch of title) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${n} 68% 58%)`;
}

/* ---------- state ---------- */
const KEY = 'my-day.v1';
const defaults = () => ({
  tasks: [],      // {id, text, done, doneAt}
  events: [],     // {id, title, start, end, allDay, src, rr}
  history: {},    // dayKey -> tasks completed that day
  unit: /^en-(US|LR|MM)$/.test(navigator.language) ? 'fahrenheit' : 'celsius',
  loc: null,      // {lat, lon, name}
  weather: null,  // {at, key, data}
  installDismissed: false,
  sync: null,     // {url, at}: Google Calendar relay link and last successful sync
});

function load() {
  let s = defaults();
  try { s = { ...s, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* corrupt or blocked storage */ }
  // Tasks finished on an earlier day drop off the list; their count lives on in `history`.
  const today = dayKey(new Date());
  s.tasks = s.tasks.filter((t) => !(t.done && t.doneAt && dayKey(new Date(t.doneAt)) !== today));
  const cutoff = dayKey(addDays(new Date(), -60));
  for (const k of Object.keys(s.history)) if (k < cutoff) delete s.history[k];
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

/* ---------- weather ---------- */
const WMO = {
  0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Rain showers'], 81: ['🌧️', 'Rain showers'], 82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
};
const wmo = (code) => WMO[code] || ['🌡️', 'Unknown'];
const locKey = () => (state.loc ? `${state.loc.lat.toFixed(2)},${state.loc.lon.toFixed(2)},${state.unit}` : '');
const deg = (v) => `${Math.round(v)}°`;
let weatherFailed = false;
let weatherLoading = false;
let syncing = false;

// Spin the refresh icon while anything is loading.
const updateBusy = () => $('#refresh').classList.toggle('spin', weatherLoading || syncing);

function skyFor(code, isDay) {
  if (code >= 95) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 45 || code === 48) return 'fog';
  if (!isDay) return 'night';
  return code <= 1 ? 'clear' : 'cloudy';
}

async function fetchWeather(force = false) {
  if (!state.loc || weatherLoading) return;
  const w = state.weather;
  if (!force && w && w.key === locKey() && Date.now() - w.at < 10 * 60 * 1000) return;
  weatherLoading = true;
  updateBusy();
  renderHero();
  const imperial = state.unit === 'fahrenheit';
  const q = new URLSearchParams({
    latitude: state.loc.lat,
    longitude: state.loc.lon,
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
    temperature_unit: state.unit,
    wind_speed_unit: imperial ? 'mph' : 'kmh',
    timezone: 'auto',
    forecast_days: 2,
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
  renderWeather();
  renderStats();
}

function currentWeather() {
  const w = state.weather;
  return w && w.key === locKey() ? w.data : null;
}

// Top-of-page summary: sky colour, big temperature, conditions, place.
let heroIcon = '';
function renderHero() {
  const hero = $('#hero');
  const data = currentWeather();
  if (!data) {
    hero.dataset.sky = 'default';
    delete document.body.dataset.sky;
    $('#hero-temp').textContent = '--°';
    $('#hero-icon').textContent = '⛅';
    heroIcon = '';
    $('#hero-desc').textContent = !state.loc ? 'Set your location to see the weather'
      : weatherFailed ? 'Weather unavailable right now' : 'Loading weather…';
    $('#hero-place').textContent = '';
    return;
  }
  const c = data.current;
  const [icon, label] = wmo(c.weather_code);
  hero.dataset.sky = document.body.dataset.sky = skyFor(c.weather_code, c.is_day);
  $('#hero-temp').textContent = deg(c.temperature_2m);
  $('#hero-desc').textContent = `${label} · feels like ${deg(c.apparent_temperature)}`;
  const el = $('#hero-icon');
  el.textContent = icon;
  if (icon !== heroIcon) {
    heroIcon = icon;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const where = state.loc && state.loc.name ? `${state.loc.name} · ` : '';
  $('#hero-place').textContent = `${where}${weatherFailed ? 'offline, last updated' : 'updated'} ${fmtTime(state.weather.at)}`;
}

let wxAnimated = false;
function renderWeather() {
  renderHero();
  const body = $('#weather-body');
  body.replaceChildren();
  body.classList.remove('animate');
  if (!state.loc) {
    body.append(h('div', { class: 'notice' },
      'Add your location to see the forecast.',
      h('button', { class: 'primary', onclick: openLocation }, ic('pin', 'ic sm'), 'Set location')));
    return;
  }
  const data = currentWeather();
  if (!data) {
    if (weatherFailed) {
      body.append(h('p', { class: 'notice' }, 'Couldn’t load the weather. Check your connection and tap the refresh button.'));
    } else {
      body.append(h('div', { class: 'skel-grid' }, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' })),
        h('div', { class: 'skel skel-row' }));
    }
    return;
  }
  const c = data.current, d = data.daily;
  const wind = `${Math.round(c.wind_speed_10m)} ${data.current_units.wind_speed_10m === 'mp/h' ? 'mph' : 'km/h'}`;
  const hm = (iso) => fmtTime(new Date(iso).getTime());
  let k = 0;
  const cell = (value, name) => h('div', { style: `--k:${k++}` }, h('b', {}, value), h('span', {}, name));

  body.append(h('div', { class: 'wx-grid' },
    cell(`${deg(d.temperature_2m_max[0])}/${deg(d.temperature_2m_min[0])}`, 'High / Low'),
    cell(`${d.precipitation_probability_max[0] ?? 0}%`, 'Rain chance'),
    cell(wind, 'Wind'),
    cell(`${c.relative_humidity_2m}%`, 'Humidity'),
    cell(hm(d.sunrise[0]), 'Sunrise'),
    cell(hm(d.sunset[0]), 'Sunset')));

  // Next 8 hours (hourly times are in the location's timezone, same as current.time).
  const nowHour = c.time.slice(0, 13);
  const start = Math.max(0, data.hourly.time.findIndex((t) => t.slice(0, 13) >= nowHour));
  const strip = h('div', { class: 'hours' });
  for (let i = start; i < Math.min(start + 8, data.hourly.time.length); i++) {
    const hr = new Date(data.hourly.time[i]);
    const p = data.hourly.precipitation_probability[i];
    strip.append(h('div', { class: 'hour', style: `--k:${i - start + 3}` },
      h('span', {}, i === start ? 'Now' : hr.toLocaleTimeString([], { hour: 'numeric' })),
      h('span', { class: 'h-ico', 'aria-hidden': 'true' }, wmo(data.hourly.weather_code[i])[0]),
      h('b', {}, deg(data.hourly.temperature_2m[i])),
      h('div', { class: 'h-rain' }, p >= 20 ? `${p}%` : '')));
  }
  body.append(strip);
  if (!wxAnimated) { wxAnimated = true; body.classList.add('animate'); } // entrance only the first time
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
  save();
  closeDlg(locDialog);
  renderWeather();
  fetchWeather(true);
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
$('#change-location').addEventListener('click', openLocation);

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
        save();
        renderWeather();
      }
      resolve();
    },
    resolve,
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 15 * 60 * 1000 }));
}
const refreshWeather = (force = false) => refreshAutoLocation().then(() => fetchWeather(force));

/* ---------- to-do ---------- */
let enterId = null;   // task row that should slide in after the next render
let todoTimer = null;

function renderTodos() {
  clearTimeout(todoTimer);
  const list = $('#todos');
  list.replaceChildren();
  const open = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);
  $('#todo-count').textContent = state.tasks.length ? `${open.length} open` : '';
  if (!state.tasks.length) list.append(h('li', { class: 'empty' }, 'Nothing here yet. Add your first task above.'));
  else if (!open.length) list.append(h('li', { class: 'empty' }, '🎉 Everything’s done. Nice work!'));
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
}

// Let the check animation finish before the row moves to its new spot.
function renderTodosSoon(ms) {
  clearTimeout(todoTimer);
  if (reduceMotion.matches) { renderTodos(); return; }
  todoTimer = setTimeout(renderTodos, ms);
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
  save(); renderTodosSoon(520); renderStats(); renderWeek();
}

function removeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t && t.done && t.doneAt && dayKey(new Date(t.doneAt)) === dayKey(new Date())) {
    // Keep today's count honest if a completed task is deleted.
    const k = dayKey(new Date());
    state.history[k] = Math.max(0, (state.history[k] || 1) - 1);
  }
  state.tasks = state.tasks.filter((x) => x.id !== id);
  const li = document.querySelector(`#todos li[data-id="${id}"]`);
  if (li && !reduceMotion.matches) {
    li.style.height = `${li.offsetHeight}px`;
    void li.offsetHeight;
    li.classList.add('removing');
  }
  buzz(8);
  save(); renderTodosSoon(260); renderStats(); renderWeek();
}

$('#todo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;
  const task = { id: uid(), text, done: false, doneAt: null };
  state.tasks.push(task);
  enterId = task.id;
  input.value = '';
  save(); renderTodos(); renderStats();
});

/* ---------- schedule ---------- */
let viewDay = startOfDay(new Date());

function dayLabel(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long' });
}

// dir: -1 = came from an earlier day, 1 = later day, 0 = plain refresh (no animation)
function renderSchedule(dir = 0) {
  swapText($('#sched-h'), dayLabel(viewDay));
  swapText($('#sched-date'), viewDay.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
  const list = $('#schedule');
  list.className = `list sched${dir > 0 ? ' swap-l' : dir < 0 ? ' swap-r' : ''}`;
  list.replaceChildren();
  const items = eventsOn(viewDay);
  if (!items.length) {
    list.append(h('li', { class: 'empty' }, dayKey(viewDay) === dayKey(new Date()) ? 'Nothing scheduled today. Enjoy the free time.' : 'Nothing scheduled.'));
    return;
  }
  const now = Date.now();
  items.forEach(({ ev, s, e }, i) => {
    const isNow = !ev.allDay && s <= now && now < e;
    const isPast = !ev.allDay && Math.max(e, s + 1) <= now;
    let sub = null;
    if (isNow) sub = h('div', { class: 's-sub' }, h('span', { class: 'live-dot' }), `Now · until ${fmtTime(e)}${ev.rr ? ' · repeats' : ''}`);
    else if (!ev.allDay && e > s) sub = h('div', { class: 's-sub' }, `until ${fmtTime(e)}${ev.rr ? ' · repeats' : ''}`);
    else if (ev.rr) sub = h('div', { class: 's-sub' }, 'repeats');
    list.append(h('li', { class: `${isNow ? 'now' : ''} ${isPast ? 'past' : ''}`.trim(), style: `--i:${i};--ev:${evColor(ev.title)}` },
      h('div', { class: 's-time' }, ev.allDay ? 'All day' : fmtTime(s)),
      h('div', { class: 's-body' }, h('div', { class: 's-title' }, ev.title), sub),
      h('button', { class: 'x-btn', 'aria-label': `Remove ${ev.title}`, onclick: () => removeEvent(ev) }, ic('x'))));
  });
}

function removeEvent(ev) {
  if (ev.rr && !confirm('This repeats. Remove every occurrence?')) return;
  state.events = state.events.filter((x) => x.id !== ev.id);
  save(); renderSchedule(); renderStats();
}

function goToDay(d) {
  const dir = d > viewDay ? 1 : d < viewDay ? -1 : 0;
  viewDay = d;
  renderSchedule(dir);
}
$('#day-prev').addEventListener('click', () => goToDay(addDays(viewDay, -1)));
$('#day-next').addEventListener('click', () => goToDay(addDays(viewDay, 1)));
const backToToday = () => goToDay(startOfDay(new Date()));
$('#sched-h').addEventListener('click', backToToday);
$('#sched-h').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); backToToday(); } });

// Add-event dialog
const evDialog = $('#event-dialog');
const evAllDay = $('#ev-allday');
evAllDay.addEventListener('change', () => { $('#ev-times').hidden = evAllDay.checked; });
$('#add-event').addEventListener('click', () => {
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
});
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
  const dir = day > viewDay ? 1 : day < viewDay ? -1 : 1;
  viewDay = day;
  renderSchedule(dir); renderStats();
});

// ICS import
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
    save(); renderSchedule(1); renderStats();
    toast(`Imported ${events.length} event${events.length === 1 ? '' : 's'}`);
  } catch {
    toast('Couldn’t read that file');
  }
});

/* ---------- Google Calendar sync (via the relay in worker/) ---------- */
let syncError = '';

function renderSyncStatus() {
  const el = $('#sync-status');
  const s = state.sync;
  if (!s) { el.textContent = ''; return; }
  const last = s.at ? `Synced ${fmtTime(s.at)}` : 'Not synced yet';
  el.textContent = syncError ? `${last}. ${syncError}` : last;
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
    renderSchedule(); renderStats(); renderSyncStatus();
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
  save(); renderSchedule(); renderStats(); renderSyncStatus();
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
  toast(`Synced ${n} calendar event${n === 1 ? '' : 's'}`);
});

/* ---------- stats & history ---------- */
const CIRC = 2 * Math.PI * 26;

function renderStats() {
  const doneToday = state.tasks.filter((t) => t.done).length;
  const total = state.tasks.length;
  const pct = total ? Math.round((doneToday / total) * 100) : 0;
  tween($('#stat-progress'), pct, (v) => `${Math.round(v)}%`);
  raf2(() => $('#ring-fg').setAttribute('stroke-dasharray', `${(pct / 100) * CIRC} ${CIRC}`));
  $('#stat-tasks-value').textContent = total ? `${doneToday} of ${total}` : '–';
  $('#stat-tasks').textContent = !total ? 'No tasks yet' : doneToday === total ? 'All done today' : 'tasks done';

  const todays = eventsOn(new Date());
  tween($('#stat-events'), todays.length);

  const data = currentWeather();
  if (data) {
    const d = data.daily;
    $('#stat-temp').textContent = `${deg(d.temperature_2m_max[0])}/${deg(d.temperature_2m_min[0])}`;
    $('#stat-temp-label').textContent = `${d.precipitation_probability_max[0] ?? 0}% chance of rain`;
  } else {
    $('#stat-temp').textContent = '–';
    $('#stat-temp-label').textContent = state.loc ? (weatherFailed ? 'weather unavailable' : 'loading weather') : 'set your location';
  }

  const now = Date.now();
  const timed = todays.filter((x) => !x.ev.allDay);
  const current = timed.find((x) => x.s <= now && now < x.e);
  const upcoming = timed.find((x) => x.s > now);
  if (current) { swapText($('#stat-next'), 'Now'); $('#stat-next-label').textContent = current.ev.title; }
  else if (upcoming) {
    const mins = Math.round((upcoming.s - now) / 60000);
    swapText($('#stat-next'), mins < 60 ? `in ${mins} min` : fmtTime(upcoming.s));
    $('#stat-next-label').textContent = upcoming.ev.title;
  } else { swapText($('#stat-next'), '–'); $('#stat-next-label').textContent = todays.length ? 'nothing more today' : 'free day'; }
}

let weekAnimated = false;
function renderWeek() {
  const wrap = $('#week-bars');
  wrap.replaceChildren();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i - 6));
  const counts = days.map((d) => state.history[dayKey(d)] || 0);
  const max = Math.max(1, ...counts);
  days.forEach((d, i) => {
    wrap.append(h('div', { class: `bar${i === 6 ? ' today' : ''}`, style: `--h:${Math.max(4, (counts[i] / max) * 72)}px;--k:${i}` },
      h('b', {}, counts[i] || ''),
      h('i'),
      h('span', {}, d.toLocaleDateString([], { weekday: 'short' }).slice(0, 3))));
  });
  if (weekAnimated) wrap.classList.add('go'); // later updates: no replay
  else { weekAnimated = true; wrap.classList.remove('go'); raf2(() => wrap.classList.add('go')); }
}

/* ---------- header & lifecycle ---------- */
function renderHeader() {
  const now = new Date();
  const hr = now.getHours();
  $('#greeting').textContent = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#today-label').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

let lastDay = dayKey(new Date());
function tick() {
  const today = dayKey(new Date());
  if (today !== lastDay) { // midnight rollover
    lastDay = today;
    viewDay = startOfDay(new Date());
    state.tasks = load().tasks; // drops yesterday's completed tasks
    renderTodos();
    renderWeek();
  }
  renderHeader();
  renderSchedule();
  renderStats();
}

$('#refresh').addEventListener('click', () => { toast('Refreshing…'); refreshWeather(true); syncCalendar(true); tick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refreshWeather(); syncCalendar(); } });
window.addEventListener('online', () => { fetchWeather(true); syncCalendar(true); });

// Android install button (Chrome/Edge/Samsung Internet fire this when the app is installable)
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (!state.installDismissed) $('#install').hidden = false;
});
window.addEventListener('appinstalled', () => { $('#install').hidden = true; });
$('#install-btn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('#install').hidden = true;
});
$('#install-dismiss').addEventListener('click', () => { state.installDismissed = true; save(); $('#install').hidden = true; });
setInterval(tick, 60 * 1000);
setInterval(() => { if (!document.hidden) syncCalendar(); }, 15 * 60 * 1000);

renderHeader();
renderTodos();
renderSchedule();
renderStats();
renderWeek();
renderWeather();
renderSyncStatus();
refreshWeather();
syncCalendar();
if (!state.loc) setTimeout(() => { if (!state.loc && !locDialog.open) openLocation(); }, 900);


/* ---------- floating dock ---------- */
// Low-end phones skip the expensive blur and use solid frosted panels instead.
if ((navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2)) document.documentElement.classList.add('lite');

const dock = $('#dock');
const dockBtns = [...dock.querySelectorAll('button')];
const dockPill = dock.querySelector('.dock-pill');
let dockActive = 'hero';
let spyLock = false, spyTimer = null;

function setDock(id) {
  const btn = dockBtns.find((b) => b.dataset.target === id);
  if (!btn) return;
  dockActive = id;
  dockPill.style.setProperty('--x', `${btn.offsetLeft}px`);
  dockPill.style.setProperty('--w', `${btn.offsetWidth}px`);
  dockBtns.forEach((b) => { b.classList.toggle('on', b === btn); b.setAttribute('aria-current', b === btn ? 'true' : 'false'); });
}

dockBtns.forEach((btn) => btn.addEventListener('click', () => {
  const id = btn.dataset.target;
  spyLock = true;
  clearTimeout(spyTimer);
  spyTimer = setTimeout(() => { spyLock = false; }, 900); // ignore the scroll-spy while we glide there
  setDock(id);
  buzz(6);
  const behavior = reduceMotion.matches ? 'auto' : 'smooth';
  if (id === 'hero') window.scrollTo({ top: 0, behavior });
  else document.getElementById(id).scrollIntoView({ behavior, block: 'start' });
}));

// The pill swells while a finger is on the dock.
dock.addEventListener('pointerdown', () => dock.classList.add('press'));
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) dock.addEventListener(ev, () => dock.classList.remove('press'));

// Scroll-spy: highlight the section that sits in the upper-middle of the screen.
if ('IntersectionObserver' in window) {
  const spy = new IntersectionObserver((entries) => {
    if (spyLock) return;
    for (const e of entries) if (e.isIntersecting) setDock(e.target.dataset.spy);
  }, { rootMargin: '-38% 0px -57% 0px' });
  for (const [sel, id] of [['#hero', 'hero'], ['#stats', 'hero'], ['#weather-card', 'weather-card'], ['#schedule-card', 'schedule-card'], ['#todo-card', 'todo-card']]) {
    const el = $(sel);
    el.dataset.spy = id;
    spy.observe(el);
  }
  let scrollQueued = false;
  addEventListener('scroll', () => {
    if (scrollQueued || spyLock) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (scrollY < 40) setDock('hero');
      else if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) setDock('todo-card');
    });
  }, { passive: true });
}
addEventListener('resize', () => setDock(dockActive));
addEventListener('load', () => setDock(dockActive));
setDock('hero');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  // A new version just took over: reload once so the fresh code shows straight away
  // (unless you're in the middle of typing or a dialog is open).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !document.querySelector('dialog[open]') && !$('#todo-input').value) location.reload();
  });
}
