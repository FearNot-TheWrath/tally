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
          el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
            el('h3', {}, [k.name]),
            k.on_freeze ? el('span', { class: 'on-freeze-pill' }, ['On freeze']) : null,
          ].filter(Boolean)),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
        el('div', { class: 'meta' }, [
          el('span', {}, [`${k.points || 0} pts (${Math.round((k.percent || 0) * 100)}%)`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
        el('div', { class: 'tasks-scroll' }, [
          el('div', { class: 'tasks-track' },
            tasks.length === 0
              ? [el('p', { class: 'muted', style: { fontSize: '0.85rem' } }, ['All clear.'])]
              : tasks.map(t => el('div', {
                  class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : '') + (t.is_bonus ? ' bonus' : ''),
                }, [
                  el('div', {}, [
                    el('span', {}, [t.title]),
                    t.is_bonus ? el('span', { style: { fontSize: '0.62rem', color: '#92400E', marginLeft: '6px' } }, ['★']) : null,
                    t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
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

  // After layout settles, turn on auto-scroll for any column whose task
  // list overflows its visible area. Duplicate the children so the marquee
  // loops seamlessly (-50% translate == one original-list height).
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

render();
setInterval(render, 10_000);

const sse = new EventSource('/api/wall/events');
sse.addEventListener('refresh', () => render());
