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

/* ---------- state ---------- */
const KEY = 'my-day.v1';
const defaults = () => ({
  tasks: [],      // {id, text, done, doneAt}
  events: [],     // {id, title, start, end, allDay, src, rr}
  history: {},    // dayKey -> tasks completed that day
  unit: /^en-(US|LR|MM)$/.test(navigator.language) ? 'fahrenheit' : 'celsius',
  loc: null,      // {lat, lon, name}
  weather: null,  // {at, key, data}
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
function icsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh || /VALUE=DATE(?!-)/i.test(params);
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)), allDay: false };
  // Floating or TZID times are treated as device-local time.
  return { ms: new Date(+y, +mo - 1, +d, +(hh || 0), +(mm || 0), +(ss || 0)).getTime(), allDay };
}

function parseRRule(text) {
  const r = {};
  for (const part of text.split(';')) {
    const [k, v] = part.split('=');
    r[k.toUpperCase()] = v;
  }
  const freq = { DAILY: 'd', WEEKLY: 'w', MONTHLY: 'm', YEARLY: 'y' }[r.FREQ];
  if (!freq) return null;
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const out = { freq, interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1) };
  if (r.COUNT) out.count = parseInt(r.COUNT, 10);
  if (r.UNTIL) { const u = icsDate(r.UNTIL, ''); if (u) out.until = u.ms + (u.allDay ? 86400000 : 0); }
  if (r.BYDAY && freq === 'w') {
    out.byday = r.BYDAY.split(',').map((d) => days.indexOf(d.slice(-2))).filter((i) => i >= 0);
  }
  return out;
}

function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  const unescape = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start != null) {
        const end = cur.end != null ? cur.end : cur.start + (cur.allDay ? 86400000 : 0);
        events.push({
          id: uid(), title: cur.title || '(No title)', start: cur.start, end,
          allDay: !!cur.allDay, src: 'ics', rr: cur.rr || null,
        });
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
      case 'DTSTART': { const d = icsDate(value, params); if (d) { cur.start = d.ms; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = icsDate(value, params); if (d) cur.end = d.ms; break; }
      case 'RRULE': cur.rr = parseRRule(value); break;
      default:
    }
  }
  return events;
}

/* ---------- calendar: occurrences ---------- */
// Yields [startMs, endMs] for each occurrence of an event, in order.
function* occurrences(ev) {
  const dur = Math.max(0, ev.end - ev.start);
  const r = ev.rr;
  if (!r) { yield [ev.start, ev.start + dur]; return; }
  const s = new Date(ev.start);
  let count = 0;
  const make = (d) => {
    const t = d.getTime();
    if (r.until != null && t > r.until) return null;
    if (r.count && ++count > r.count) return null;
    return [t, t + dur];
  };
  for (let i = 0; i < 20000; i++) {
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
      const d = new Date(s);
      if (r.freq === 'd') d.setDate(s.getDate() + i * r.interval);
      else if (r.freq === 'm') {
        d.setMonth(s.getMonth() + i * r.interval);
        if (d.getDate() !== s.getDate()) continue; // e.g. the 31st in a 30-day month
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
    for (const [s, e] of occurrences(ev)) {
      if (s >= to) break;
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
let weatherFailed = false;
let weatherLoading = false;

async function fetchWeather(force = false) {
  if (!state.loc || weatherLoading) return;
  const w = state.weather;
  if (!force && w && w.key === locKey() && Date.now() - w.at < 20 * 60 * 1000) return;
  weatherLoading = true;
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
  }
  renderWeather();
  renderStats();
}

function currentWeather() {
  const w = state.weather;
  return w && w.key === locKey() ? w.data : null;
}

function renderWeather() {
  const body = $('#weather-body');
  body.replaceChildren();
  if (!state.loc) {
    body.append(h('div', { class: 'notice' },
      'Add your location to see the forecast.',
      h('br'),
      h('button', { class: 'primary', onclick: openLocation }, 'Set location')));
    return;
  }
  const data = currentWeather();
  if (!data) {
    body.append(h('p', { class: 'notice' }, weatherFailed ? 'Couldn’t load the weather. Check your connection and tap ↻.' : 'Loading weather…'));
    return;
  }
  const c = data.current, d = data.daily;
  const [icon, label] = wmo(c.weather_code);
  const deg = (v) => `${Math.round(v)}°`;
  const wind = `${Math.round(c.wind_speed_10m)} ${data.current_units.wind_speed_10m === 'mp/h' ? 'mph' : 'km/h'}`;
  const hm = (iso) => fmtTime(new Date(iso).getTime());

  body.append(
    h('div', { class: 'wx-main' },
      h('div', { class: 'wx-icon', 'aria-hidden': 'true' }, icon),
      h('div', {},
        h('div', { class: 'wx-temp' }, deg(c.temperature_2m)),
        h('div', { class: 'wx-desc' }, `${label} · feels ${deg(c.apparent_temperature)}`))),
    h('div', { class: 'wx-grid' },
      cell(`${deg(d.temperature_2m_max[0])} / ${deg(d.temperature_2m_min[0])}`, 'High / Low'),
      cell(`${d.precipitation_probability_max[0] ?? 0}%`, 'Rain'),
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
    strip.append(h('div', { class: 'hour' },
      h('span', {}, i === start ? 'Now' : hr.toLocaleTimeString([], { hour: 'numeric' })),
      h('span', { class: 'h-ico', 'aria-hidden': 'true' }, wmo(data.hourly.weather_code[i])[0]),
      h('b', {}, deg(data.hourly.temperature_2m[i])),
      h('div', { class: 'h-rain' }, p >= 20 ? `${p}%` : '')));
  }
  body.append(strip);
  const where = state.loc.name ? `${state.loc.name} · ` : '';
  const stale = weatherFailed ? ' (offline, showing last update)' : '';
  body.append(h('p', { class: 'muted small-text', style: 'margin-top:8px' }, `${where}updated ${fmtTime(state.weather.at)}${stale}`));

  function cell(value, name) { return h('div', {}, h('b', {}, value), h('span', {}, name)); }
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
  locDialog.close();
  renderWeather();
  fetchWeather(true);
}

$('#loc-gps').addEventListener('click', () => {
  const msg = $('#loc-msg');
  if (!navigator.geolocation) { msg.textContent = 'Location isn’t available on this device. Search for a city instead.'; return; }
  msg.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Current location' }),
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
$('#loc-close').addEventListener('click', () => locDialog.close());
$('#change-location').addEventListener('click', openLocation);

/* ---------- to-do ---------- */
function renderTodos() {
  const list = $('#todos');
  list.replaceChildren();
  const open = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);
  $('#todo-count').textContent = state.tasks.length ? `${open.length} open` : '';
  if (!state.tasks.length) list.append(h('li', { class: 'empty' }, 'Nothing to do. Add your first task above.'));
  const row = (t) => h('li', { class: `todo${t.done ? ' done' : ''}` },
    h('label', {},
      h('input', { type: 'checkbox', checked: t.done, onchange: () => toggleTask(t.id) }),
      h('span', {}, t.text)),
    h('button', { class: 'x-btn', 'aria-label': `Delete ${t.text}`, onclick: () => removeTask(t.id) }, '✕'));
  open.forEach((t) => list.append(row(t)));
  if (done.length) {
    list.append(h('li', { class: 'sep' }, 'Done today'));
    done.forEach((t) => list.append(row(t)));
  }
}

function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const today = dayKey(new Date());
  if (!t.done) {
    t.done = true; t.doneAt = Date.now();
    state.history[today] = (state.history[today] || 0) + 1;
  } else {
    if (t.doneAt && dayKey(new Date(t.doneAt)) === today) state.history[today] = Math.max(0, (state.history[today] || 1) - 1);
    t.done = false; t.doneAt = null;
  }
  save(); renderTodos(); renderStats(); renderWeek();
}

function removeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t && t.done && t.doneAt && dayKey(new Date(t.doneAt)) === dayKey(new Date())) {
    // Keep today's count honest if a completed task is deleted.
    const k = dayKey(new Date());
    state.history[k] = Math.max(0, (state.history[k] || 1) - 1);
  }
  state.tasks = state.tasks.filter((x) => x.id !== id);
  save(); renderTodos(); renderStats(); renderWeek();
}

$('#todo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;
  state.tasks.push({ id: uid(), text, done: false, doneAt: null });
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

function renderSchedule() {
  $('#sched-h').textContent = dayLabel(viewDay);
  $('#sched-date').textContent = viewDay.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const list = $('#schedule');
  list.className = 'list sched';
  list.replaceChildren();
  const items = eventsOn(viewDay);
  if (!items.length) { list.append(h('li', { class: 'empty' }, 'Nothing scheduled.')); return; }
  const now = Date.now();
  for (const { ev, s, e } of items) {
    const isNow = !ev.allDay && s <= now && now < e;
    const isPast = !ev.allDay && Math.max(e, s + 1) <= now;
    list.append(h('li', { class: `${isNow ? 'now' : ''} ${isPast ? 'past' : ''}` },
      h('div', { class: 's-time' }, ev.allDay ? 'All day' : fmtTime(s)),
      h('div', { class: 's-body' },
        h('div', { class: 's-title' }, ev.title),
        !ev.allDay && e > s ? h('div', { class: 's-sub' }, `until ${fmtTime(e)}${ev.rr ? ' · repeats' : ''}`) : (ev.rr ? h('div', { class: 's-sub' }, 'repeats') : null)),
      h('button', { class: 'x-btn', 'aria-label': `Remove ${ev.title}`, onclick: () => removeEvent(ev) }, '✕')));
  }
}

function removeEvent(ev) {
  if (ev.rr && !confirm('This repeats. Remove every occurrence?')) return;
  state.events = state.events.filter((x) => x.id !== ev.id);
  save(); renderSchedule(); renderStats();
}

$('#day-prev').addEventListener('click', () => { viewDay = addDays(viewDay, -1); renderSchedule(); });
$('#day-next').addEventListener('click', () => { viewDay = addDays(viewDay, 1); renderSchedule(); });
$('#sched-h').addEventListener('click', () => { viewDay = startOfDay(new Date()); renderSchedule(); });

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
$('#ev-cancel').addEventListener('click', () => evDialog.close());
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
  save(); evDialog.close();
  viewDay = startOfDay(new Date(start));
  renderSchedule(); renderStats();
});

// ICS import
$('#import-ics').addEventListener('click', () => $('#ics-file').click());
$('#ics-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large'); return; }
  try {
    const events = parseICS(await file.text());
    if (!events.length) { toast('No events found in that file'); return; }
    state.events = state.events.filter((x) => x.src !== 'ics').concat(events);
    save(); renderSchedule(); renderStats();
    toast(`Imported ${events.length} event${events.length === 1 ? '' : 's'}`);
  } catch {
    toast('Couldn’t read that file');
  }
});

/* ---------- stats & history ---------- */
const CIRC = 2 * Math.PI * 26;

function renderStats() {
  const doneToday = state.tasks.filter((t) => t.done).length;
  const open = state.tasks.length - doneToday;
  const total = doneToday + open;
  const pct = total ? Math.round((doneToday / total) * 100) : 0;
  $('#stat-progress').textContent = `${pct}%`;
  $('#stat-tasks').textContent = total ? `${doneToday} of ${total} tasks done` : 'No tasks yet';
  $('#ring-fg').setAttribute('stroke-dasharray', `${(pct / 100) * CIRC} ${CIRC}`);

  const todays = eventsOn(new Date());
  $('#stat-events').textContent = todays.length;

  const data = currentWeather();
  if (data) {
    $('#stat-temp').textContent = `${Math.round(data.current.temperature_2m)}°`;
    $('#stat-temp-label').textContent = wmo(data.current.weather_code)[1];
  } else {
    $('#stat-temp').textContent = '--';
    $('#stat-temp-label').textContent = state.loc ? 'loading weather' : 'set location';
  }

  const now = Date.now();
  const timed = todays.filter((x) => !x.ev.allDay);
  const current = timed.find((x) => x.s <= now && now < x.e);
  const upcoming = timed.find((x) => x.s > now);
  if (current) { $('#stat-next').textContent = 'Now'; $('#stat-next-label').textContent = current.ev.title; }
  else if (upcoming) {
    const mins = Math.round((upcoming.s - now) / 60000);
    $('#stat-next').textContent = mins < 60 ? `${mins}m` : fmtTime(upcoming.s);
    $('#stat-next-label').textContent = upcoming.ev.title;
  } else { $('#stat-next').textContent = '--'; $('#stat-next-label').textContent = todays.length ? 'nothing more today' : 'free day'; }
}

function renderWeek() {
  const wrap = $('#week-bars');
  wrap.replaceChildren();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i - 6));
  const counts = days.map((d) => state.history[dayKey(d)] || 0);
  const max = Math.max(1, ...counts);
  days.forEach((d, i) => {
    wrap.append(h('div', { class: `bar${i === 6 ? ' today' : ''}` },
      h('b', {}, counts[i] || ''),
      h('i', { style: `height:${Math.max(3, (counts[i] / max) * 70)}px` }),
      h('span', {}, d.toLocaleDateString([], { weekday: 'short' }).slice(0, 3))));
  });
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

$('#refresh').addEventListener('click', () => { toast('Refreshing…'); fetchWeather(true); tick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); fetchWeather(); } });
setInterval(tick, 60 * 1000);

renderHeader();
renderTodos();
renderSchedule();
renderStats();
renderWeek();
renderWeather();
fetchWeather();
if (!state.loc) setTimeout(() => { if (!state.loc && !locDialog.open) openLocation(); }, 600);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
