import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const root = document.getElementById('wall');
let lastDataJson = null;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function applyServerTheme() {
  // Wall theme is set in the settings table as 'wall_theme' (system/light/dark).
  // For Phase 1 we use system preference; explicit fetch via a public endpoint
  // can be added in Phase 6 along with the dark-mode toggle.
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${h}:${m} ${ampm}`;
}

function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

async function render() {
  await applyServerTheme();
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

  // If only the clock needs updating, update it in place.
  if (headerOnly) {
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
        el('div', { class: 'st-num' }, [`${k.today.filter(t => t.status === 'done').length}/${k.today.length}`]),
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
          el('h3', {}, [k.name]),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
        el('div', { class: 'meta' }, [
          el('span', {}, [`target ${k.weekly_target_pts || 0} pts`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
        el('div', { class: 'stack', style: { gap: '6px' } },
          tasks.length === 0
            ? [el('p', { class: 'muted', style: { fontSize: '0.85rem' } }, ['All clear.'])]
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : ''),
              }, [
                el('span', {}, [t.title]),
                el('span', { class: 'p' }, [`+${t.points}`]),
              ]))
        ),
      ]);
    })
  );

  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    cols,
  ]));
}

render();
setInterval(render, 10_000);
