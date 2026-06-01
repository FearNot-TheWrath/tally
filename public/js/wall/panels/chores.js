import { api } from '../../lib/api.js';
import { isMilestone, streakConfetti, milestoneConfetti } from '../../lib/confetti.js';

const wallStreakCache = new Map();
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
    el('div', {}, [`${data.house_pct}% done today`]),
    el('div', { class: 'muted' }, [`${data.kids.length} kids · ${data.today}`]),
  ]);
  host.appendChild(banner);

  const grid = el('div', { class: 'wall-kid-grid' },
    data.kids.map(k => {
      const prevStreak = wallStreakCache.get(k.id) || 0;
      if (!firstRender && k.streak_days > prevStreak && isMilestone(k.streak_days)) {
        milestoneConfetti(k.avatar_color);
      } else if (!firstRender && k.streak_days > prevStreak) {
        streakConfetti(k.avatar_color);
      }
      wallStreakCache.set(k.id, k.streak_days);

      return el('div', { class: 'wall-kid' }, [
        el('div', { class: 'wall-kid-av', style: { background: k.avatar_color } }, [k.name[0]]),
        el('div', { class: 'wall-kid-name' }, [k.name]),
        el('div', { class: 'wall-kid-pct' }, [`${k.percent}%`]),
        k.streak_days > 0
          ? el('div', { class: 'wall-kid-streak' }, [`${k.streak_days}d streak`])
          : null,
        k.on_freeze ? el('div', { class: 'wall-kid-freeze' }, ['On freeze']) : null,
      ]);
    })
  );
  host.appendChild(grid);
  firstRender = false;
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
  // Expose the parsed data's streak leader for the persistent header.
  extractStreakLeader(data) {
    return data?.streak_leader || null;
  },
};
