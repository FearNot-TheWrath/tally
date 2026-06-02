import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';
import { isMilestone, streakConfetti, milestoneConfetti } from '../lib/confetti.js';
import { Rotation } from '../wall/rotation.js';
import { isInSleepWindow } from '../wall/sleep.js';

const root = document.getElementById('wall');
let lastDataJson = null;
const wallStreakCache = new Map();
let wallFirstRender = true;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const WEATHER_ICONS = {
  'clear-day':     '☀️',
  'clear-night':   '🌙',
  'partly-cloudy': '⛅',
  'overcast':      '☁️',
  'fog':           '🌫️',
  'rain':          '🌧️',
  'snow':          '❄️',
  'thunderstorm':  '⛈️',
};

// Config (populated from /api/wall/config on boot; defaults ensure chores-only fallback)
let cfg = {
  enabled_panels:    ['chores'],
  chores_dwell_sec:  60,
  other_dwell_sec:   15,
  sleep_start:       '00:00',
  sleep_end:         '00:00',
  sleep_clock_style: 'digital',
};

let rotation = new Rotation(cfg.enabled_panels, {
  choresDwellSec: cfg.chores_dwell_sec,
  otherDwellSec:  cfg.other_dwell_sec,
});

let rotationTimer   = null;
let sleepCheckTimer = null;
let sleepClockTimer = null;
let sleepDriftTimer = null;
let inSleep         = false;

// Diagnostics (visible only with ?debug in the URL).
const BUILD_TAG = 'wx-2026-06-01e';
let lastWallError = '';
let nextSwitchAt = 0;

// ------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------

// Drive the whole wall's light/dark by day vs night (the same `is_day` the
// weather slide uses), so the chores slide goes dark at night instead of
// flashing blinding white after the dark weather slide.
let wallIsDay = true;
function applyDayNightTheme() {
  document.documentElement.setAttribute('data-theme', wallIsDay ? 'light' : 'dark');
}
function setDayNight(isDay) {
  if (isDay === wallIsDay) return;
  wallIsDay = isDay;
  applyDayNightTheme();
}

// ------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${h}:${m} ${ampm}`;
}

function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function fmtHHMM(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ------------------------------------------------------------------
// Chores render (verbatim from pre-Suite wall.js)
// ------------------------------------------------------------------

async function renderChores() {
  const data = await api.get('/api/wall').catch(() => null);
  if (!data) {
    if (lastDataJson === null) {
      clear(root);
      root.appendChild(el('div', { class: 'wall-page' }, [
        el('h2', {}, ['Connecting…']),
      ]));
    }
    return;
  }
  const dataJson = JSON.stringify(data);
  const headerOnly = dataJson === lastDataJson;
  lastDataJson = dataJson;

  const now = new Date();

  // If only the clock needs updating, update it in place — but ONLY when the
  // chores panel is actually on screen. The weather panel also has a
  // `.wall-header .t` clock, so without the `.wall-cols` guard this fast-path
  // would update the weather clock and return, leaving weather up forever when
  // rotating weather -> chores with unchanged chore data.
  if (headerOnly && root.querySelector('.wall-cols')) {
    const t = root.querySelector('.wall-header .t');
    if (t) { t.textContent = fmtTime(now); return; }
  }

  // Otherwise full redraw.
  clear(root);

  const banner = el('div', { class: 'wall-banner' }, [
    el('div', {}, [
      el('div', { class: 'pct-label label' }, ['House progress today']),
      el('div', { class: 'pct' }, [String(data.house_pct), el('span', { class: 'denom' }, ['%'])]),
    ]),
    el('div', { class: 'wall-stats' },
      data.kids.map(k => el('div', {}, [
        el('div', { class: 'st-num' }, [`${k.today.filter(t => t.status === 'done').length}/${k.today.filter(t => t.status !== 'excused').length}`]),
        el('div', { class: 'st-name' }, [k.name]),
      ]))
    ),
  ]);

  const cols = el('div', { class: 'wall-cols' },
    data.kids.map(k => {
      const tasks = [
        ...k.today.map(t => ({ ...t, over: false })),
        ...k.overdue.map(t => ({ ...t, over: true })),
      ];
      return el('div', { class: 'wall-col' }, [
        el('div', { class: 'col-head' }, [
          el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
            el('h3', {}, [k.name]),
            k.on_freeze ? el('span', { class: 'on-freeze-pill' }, ['On freeze']) : null,
          ].filter(Boolean)),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
        el('div', { class: 'meta' }, [
          el('span', { style: { color: 'var(--green)' } }, [`$${((k.bank_cents || 0) / 100).toFixed(2)}`]),
          el('span', {}, [`${k.points || 0} pts (${Math.round((k.percent || 0) * 100)}%)`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
        el('div', { class: 'tasks-scroll' }, [
          el('div', { class: 'tasks-track' },
            tasks.length === 0
              ? [el('p', { class: 'muted', style: { fontSize: '0.85rem' } }, ['All clear.'])]
              : tasks.map(t => el('div', {
                  class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : '') + (t.is_bonus ? ' bonus' : '') + (t.status === 'excused' ? ' excused' : ''),
                }, [
                  el('div', {}, [
                    el('span', {}, [t.title]),
                    t.is_bonus ? el('span', { style: { fontSize: '0.62rem', color: '#92400E', marginLeft: '6px' } }, ['★']) : null,
                    t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
                    t.status === 'excused' ? el('span', { style: { fontSize: '0.62rem', color: '#5B21B6', marginLeft: '6px' } }, ['· Excused']) : null,
                  ].filter(Boolean)),
                  el('span', { class: 'p' }, [`+${t.display_points || 0}`]),
                ]))
          ),
        ]),
      ]);
    })
  );

  const bonusStrip = (data.bonuses && data.bonuses.length > 0)
    ? el('div', { class: 'wall-bonus-strip' }, [
        el('div', { class: 'wall-bonus-strip-label' }, ['Bonus board · up for grabs']),
        el('div', { class: 'wall-bonus-strip-items' },
          data.bonuses.map(b => el('div', { class: 'wall-bonus-item' }, [
            el('div', { class: 'wall-bonus-title' }, [b.title]),
            el('div', { class: 'wall-bonus-pts' }, [`+${b.points}`]),
          ]))
        ),
      ])
    : null;

  const streakLeaderBanner = data.streak_leader
    ? el('div', { class: 'wall-streak-leader' }, [
        el('span', { class: 'wall-streak-leader-label' }, ['Streak leader · ']),
        el('span', {
          class: 'wall-streak-leader-name',
          style: { color: data.streak_leader.color },
        }, [data.streak_leader.name]),
        el('span', { class: 'wall-streak-leader-days' }, [` · ${data.streak_leader.streak_days} days`]),
      ])
    : null;

  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    streakLeaderBanner,
    cols,
    bonusStrip,
  ].filter(Boolean)));

  // Streak confetti tracking.
  if (wallFirstRender) {
    for (const k of data.kids) wallStreakCache.set(k.id, k.streak_days || 0);
    wallFirstRender = false;
  } else {
    for (const k of data.kids) {
      const prev = wallStreakCache.get(k.id) || 0;
      if ((k.streak_days || 0) > prev) {
        if (isMilestone(k.streak_days)) milestoneConfetti(k.streak_days, k.avatar_color);
        else streakConfetti(k.avatar_color);
      }
      wallStreakCache.set(k.id, k.streak_days || 0);
    }
  }

  requestAnimationFrame(() => {
    for (const scrollWin of root.querySelectorAll('.tasks-scroll')) {
      const track = scrollWin.querySelector('.tasks-track');
      if (!track) continue;
      // Reset before measuring in case a prior render left this in scrolling state.
      track.classList.remove('scrolling');
      if (track.scrollHeight > scrollWin.clientHeight + 4) {
        const originalCount = track.children.length;
        for (const child of [...track.children]) {
          track.appendChild(child.cloneNode(true));
        }
        // ~3s per item, minimum 20s total. Slow enough to read.
        const duration = Math.max(20, originalCount * 3);
        track.style.setProperty('--scroll-duration', duration + 's');
        track.classList.add('scrolling');
      }
    }
  });
}

// ------------------------------------------------------------------
// Weather render
// ------------------------------------------------------------------

async function renderWeather() {
  const data = await api.get('/api/wall/weather').catch(() => null);
  if (!data || data.skip) { await renderChores(); return; }

  setDayNight(!!data.is_day); // keep the whole wall in sync with day/night

  clear(root);
  const now = new Date();
  const u = data.unit === 'C' ? '°C' : '°F';
  const theme = data.theme || 'clear-day';
  const dayName = iso => DAYS[new Date(iso + 'T00:00:00').getDay()].slice(0, 3);
  const hhmm = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  };

  const heroFc = (data.forecast || []).slice(0, 3).map(day =>
    el('div', { class: 'day' }, [
      el('div', { class: 'label' }, [dayName(day.day_iso)]),
      el('div', { class: 'ico' }, [WEATHER_ICONS[day.theme] || '·']),
      el('div', { class: 'hilo' }, [`${day.high}°/${day.low}°`]),
      el('div', { class: 'pop' }, [`${day.precip}%`]),
    ])
  );

  const hrs = (data.hourly || []).slice(0, 12);
  let curveEls = [];
  if (hrs.length >= 2) {
    const temps = hrs.map(h => h.temp);
    const min = Math.min(...temps), max = Math.max(...temps);
    const span = (max - min) || 1;
    const pts = hrs.map((h, i) => {
      const x = (i / (hrs.length - 1)) * 100;
      const y = 24 - ((h.temp - min) / span) * 20;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 28');
    svg.setAttribute('preserveAspectRatio', 'none');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    svg.appendChild(poly);
    curveEls = [el('div', { class: 'weather-curve' }, [svg])];

    const fmtH = d => { let h = new Date(d.time).getHours(); const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12; return `${h}${ap}`; };
    const idxs = [0, 3, 6, 9, hrs.length - 1].filter((v, i, a) => v < hrs.length && a.indexOf(v) === i);
    const labels = idxs.map(i =>
      el('span', {}, [i === 0 ? `Now ${hrs[0].temp}°` : `${fmtH(hrs[i])} ${hrs[i].temp}°`]));
    const sun = data.is_day ? `🌙 ${hhmm(data.sunset)}` : `☀️ ${hhmm(data.sunrise)}`;
    labels.splice(Math.ceil(labels.length / 2), 0, el('span', {}, [sun]));
    curveEls.push(el('div', { class: 'weather-hours' }, labels));
  }

  const nextSun = data.is_day ? ['Sunset', hhmm(data.sunset)] : ['Sunrise', hhmm(data.sunrise)];
  const metrics = el('div', { class: 'weather-metrics' }, [
    ['Humidity', `${data.humidity}%`],
    ['Wind', `${data.wind} ${data.unit === 'C' ? 'km/h' : 'mph'}`],
    ['Rain chance', `${data.today_precip}%`],
    nextSun,
  ].map(([k, v]) => el('div', { class: 'm' }, [
    el('div', { class: 'k' }, [k]), el('div', { class: 'v' }, [v]),
  ])));

  const radarEnabled = !!(data.radar && data.radar.enabled);
  const radarEls = [];
  if (radarEnabled) {
    // Server-rendered animated radar (RainViewer + dark map, baked into a WebP
    // refreshed every ~5 min). The wall just plays the finished image over the
    // gradient — no Leaflet, no blend — so it stays light enough for the Pi.
    // The cb bucket changes every 5 min to pull the freshly generated frame.
    const cb = Math.floor(Date.now() / 300000);
    const bg = el('div', { class: 'weather-radar' }, []);
    bg.style.backgroundImage = `url('/generated/wall-radar.webp?cb=${cb}')`;
    radarEls.push(bg, el('div', { class: 'weather-radar-tag' }, ['◗ Live radar']));
  }

  root.appendChild(el('div', { class: `wall-page wall-page-weather weather-theme-${theme}` }, [
    ...radarEls,
    el('div', { class: 'weather-layer' }, [
      el('div', { class: 'wall-header' }, [
        el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
        el('span', { class: 't' }, [fmtTime(now)]),
      ]),
      el('div', { class: 'weather-hero' }, [
        el('div', { class: 'weather-ico' }, [WEATHER_ICONS[theme] || '·']),
        el('div', { class: 'temp' }, [`${data.current_temp}${u}`]),
        el('div', {}, [
          el('div', { class: 'cond' }, [data.condition || '']),
          el('div', { class: 'sub' }, [`Feels ${data.apparent_temp}${u} · H ${data.today_high}° L ${data.today_low}°`]),
        ]),
      ]),
      ...curveEls,
      el('div', { class: 'weather-fc' }, heroFc),
      metrics,
    ]),
  ]));
}

// ------------------------------------------------------------------
// Sleep mode
// ------------------------------------------------------------------

function buildDigitalFace() {
  const face = document.createElement('div');
  face.className = 'sleep-face digital';
  face.textContent = fmtTime(new Date());
  return face;
}

function buildAnalogFace(style) {
  const SIZE = 300;
  const R    = SIZE / 2;
  const ns   = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('width',  '30vh');
  svg.setAttribute('height', '30vh');

  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', R); circle.setAttribute('cy', R); circle.setAttribute('r', R - 4);
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'rgba(255,255,255,0.12)');
  circle.setAttribute('stroke-width', '2');
  svg.appendChild(circle);

  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * (Math.PI / 180);
    if (style === 'analog-classic') {
      const tx = R + Math.cos(angle) * (R - 22);
      const ty = R + Math.sin(angle) * (R - 22);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', tx); text.setAttribute('y', ty);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('font-size', '18');
      text.setAttribute('fill', 'rgba(255,255,255,0.12)');
      text.textContent = String(i === 0 ? 12 : i);
      svg.appendChild(text);
    } else {
      const x1 = R + Math.cos(angle) * (R - 10);
      const y1 = R + Math.sin(angle) * (R - 10);
      const x2 = R + Math.cos(angle) * (R - 20);
      const y2 = R + Math.sin(angle) * (R - 20);
      const tick = document.createElementNS(ns, 'line');
      tick.setAttribute('x1', x1); tick.setAttribute('y1', y1);
      tick.setAttribute('x2', x2); tick.setAttribute('y2', y2);
      tick.setAttribute('stroke', 'rgba(255,255,255,0.12)');
      tick.setAttribute('stroke-width', '2');
      svg.appendChild(tick);
    }
  }

  const hourHand = document.createElementNS(ns, 'line');
  hourHand.id = 'sh-hour';
  svg.appendChild(hourHand);

  const minHand = document.createElementNS(ns, 'line');
  minHand.id = 'sh-min';
  svg.appendChild(minHand);

  function updateHands() {
    const now = new Date();
    const h   = now.getHours() % 12 + now.getMinutes() / 60;
    const m   = now.getMinutes() + now.getSeconds() / 60;
    const ha  = (h * 30 - 90) * (Math.PI / 180);
    const ma  = (m * 6  - 90) * (Math.PI / 180);
    const hLen = R * 0.5;
    const mLen = R * 0.75;
    hourHand.setAttribute('x1', R); hourHand.setAttribute('y1', R);
    hourHand.setAttribute('x2', R + Math.cos(ha) * hLen);
    hourHand.setAttribute('y2', R + Math.sin(ha) * hLen);
    hourHand.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    hourHand.setAttribute('stroke-width', '4');
    hourHand.setAttribute('stroke-linecap', 'round');
    minHand.setAttribute('x1', R); minHand.setAttribute('y1', R);
    minHand.setAttribute('x2', R + Math.cos(ma) * mLen);
    minHand.setAttribute('y2', R + Math.sin(ma) * mLen);
    minHand.setAttribute('stroke', 'rgba(255,255,255,0.20)');
    minHand.setAttribute('stroke-width', '2.5');
    minHand.setAttribute('stroke-linecap', 'round');
  }

  updateHands();
  svg._updateHands = updateHands;

  const face = document.createElement('div');
  face.className = 'sleep-face analog';
  face.appendChild(svg);
  return face;
}

function driftFace(face) {
  const maxX = Math.max(0, window.innerWidth  - 340);
  const maxY = Math.max(0, window.innerHeight - 340);
  face.style.left = Math.floor(Math.random() * maxX) + 'px';
  face.style.top  = Math.floor(Math.random() * maxY) + 'px';
}

function enterSleep() {
  if (inSleep) return;
  inSleep = true;

  if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }

  document.body.style.background = '#000';
  clear(root);

  const style = cfg.sleep_clock_style || 'digital';
  const face  = style === 'digital' ? buildDigitalFace() : buildAnalogFace(style);
  face.style.position   = 'absolute';
  face.style.transition = 'left 3s ease, top 3s ease';
  root.appendChild(face);

  // Defer initial drift so the CSS transition fires.
  setTimeout(() => driftFace(face), 50);

  sleepClockTimer = setInterval(() => {
    if (style === 'digital') {
      face.textContent = fmtTime(new Date());
    } else {
      const svg = face.querySelector('svg');
      if (svg && svg._updateHands) svg._updateHands();
    }
  }, 1000);

  sleepDriftTimer = setInterval(() => driftFace(face), 60_000);
}

function exitSleep() {
  if (!inSleep) return;
  inSleep = false;

  if (sleepClockTimer) { clearInterval(sleepClockTimer); sleepClockTimer = null; }
  if (sleepDriftTimer) { clearInterval(sleepDriftTimer); sleepDriftTimer = null; }

  document.body.style.background = '';
  clear(root);
  lastDataJson = null; // force fresh chores redraw

  startRotation();
}

// ------------------------------------------------------------------
// Sleep check
// ------------------------------------------------------------------

function checkSleep() {
  const start = cfg.sleep_start || '00:00';
  const end   = cfg.sleep_end   || '00:00';
  const now   = fmtHHMM(new Date());
  const shouldSleep = isInSleepWindow(now, start, end);

  if (shouldSleep && !inSleep) enterSleep();
  else if (!shouldSleep && inSleep) exitSleep();
}

// ------------------------------------------------------------------
// Rotation driver
// ------------------------------------------------------------------

async function renderPanel() {
  if (rotation.current() === 'weather') {
    await renderWeather();
  } else {
    await renderChores();
  }
}

function scheduleNext() {
  const ms = rotation.nextDwellMs();
  nextSwitchAt = Date.now() + ms;
  rotationTimer = setTimeout(async () => {
    // A render error must never freeze the wall: always reschedule. Log the
    // cause so a one-off render failure is visible without halting rotation.
    try {
      rotation.advance(() => false);
      await renderPanel();
    } catch (e) {
      lastWallError = (e && e.message) || String(e);
      console.error('[wall] panel render failed:', e);
    } finally {
      scheduleNext();
    }
  }, ms);
}

function startRotation() {
  if (rotationTimer) clearTimeout(rotationTimer);
  renderPanel().then(() => scheduleNext());
}

// ------------------------------------------------------------------
// Config fetch
// ------------------------------------------------------------------

async function loadConfig() {
  const data = await api.get('/api/wall/config').catch(() => null);
  if (!data) return;

  // /api/wall/config returns enabled_panels as a comma-separated string;
  // normalize to an array of known panel keys (others are not built yet).
  const KNOWN = new Set(['chores', 'weather']);
  const parsed = (typeof data.enabled_panels === 'string'
    ? data.enabled_panels.split(',')
    : Array.isArray(data.enabled_panels) ? data.enabled_panels : ['chores']
  ).map(s => String(s).trim()).filter(s => KNOWN.has(s));
  cfg.enabled_panels = parsed.length ? parsed : ['chores'];
  cfg.chores_dwell_sec  = data.chores_dwell_sec  || 60;
  cfg.other_dwell_sec   = data.other_dwell_sec   || 15;
  cfg.sleep_start       = data.sleep_start       || '00:00';
  cfg.sleep_end         = data.sleep_end         || '00:00';
  cfg.sleep_clock_style = data.sleep_clock_style || 'digital';

  rotation = new Rotation(cfg.enabled_panels, {
    choresDwellSec: cfg.chores_dwell_sec,
    otherDwellSec:  cfg.other_dwell_sec,
  });
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

applyDayNightTheme(); // default light until we learn day/night from the weather

await loadConfig();

// Learn day/night up front so the FIRST chores slide already matches (chores is
// the home-base slide, shown before the weather slide gets a chance to set it).
try {
  const w = await api.get('/api/wall/weather');
  if (w && !w.skip && 'is_day' in w) setDayNight(!!w.is_day);
} catch { /* leave default light */ }

checkSleep();
sleepCheckTimer = setInterval(checkSleep, 60_000);

if (!inSleep) startRotation();

// Optional on-screen diagnostic: load /wall?debug to see rotation state live.
if (new URLSearchParams(location.search).has('debug')) {
  const dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.8);'
    + 'color:#0f0;font:12px monospace;padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre;';
  document.body.appendChild(dbg);
  setInterval(() => {
    const secs = Math.max(0, Math.round((nextSwitchAt - Date.now()) / 1000));
    dbg.textContent =
      `build ${BUILD_TAG}\npanel ${rotation.current()}  sleep ${inSleep}\n`
      + `next switch in ${secs}s\nleaflet ${typeof window.L !== 'undefined'}\n`
      + `err ${lastWallError || 'none'}`;
  }, 500);
}

// Kiosk self-update: reload once a day at ~3 AM (inside the sleep window, so it's
// never visible) to pick up new deploys without anyone touching the Pi.
function scheduleDailyReload() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next - now);
}
scheduleDailyReload();

// SSE: only re-render chores if chores panel is active and not sleeping.
const sse = new EventSource('/api/wall/events');
sse.addEventListener('refresh', async () => {
  if (inSleep) return;
  if (rotation.current() !== 'chores') return;
  lastDataJson = null;
  await renderChores();
});
