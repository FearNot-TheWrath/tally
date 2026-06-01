import { api } from '../../lib/api.js';
import { isMilestone, streakConfetti, milestoneConfetti } from '../../lib/confetti.js';

export const wallStreakCache = new Map();
let firstRender = true;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderBody(host, data) {
  host.innerHTML = '';

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

  host.appendChild(banner);
  if (streakLeaderBanner) host.appendChild(streakLeaderBanner);
  host.appendChild(cols);
  if (bonusStrip) host.appendChild(bonusStrip);

  // Streak confetti tracking
  if (firstRender) {
    for (const k of data.kids) wallStreakCache.set(k.id, k.streak_days || 0);
    firstRender = false;
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

  // After layout settles, enable auto-scroll for overflowing task columns.
  requestAnimationFrame(() => {
    for (const scrollWin of host.querySelectorAll('.tasks-scroll')) {
      const track = scrollWin.querySelector('.tasks-track');
      if (!track) continue;
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

export default {
  key: 'chores',
  async fetch() {
    const data = await api.get('/api/wall').catch(() => null);
    if (!data) return { skip: true, reason: 'wall fetch failed' };
    return { data };
  },
  mount(host, data) {
    host.classList.add('wall-panel-chores');
    renderBody(host, data);
  },
  unmount() {
    // No timers to clear; SSE is managed by the stage.
  },
  refresh(data) {
    const host = document.querySelector('.wall-panel-chores');
    if (host && data) renderBody(host, data);
  },
  extractStreakLeader(data) {
    return data?.streak_leader || null;
  },
};
