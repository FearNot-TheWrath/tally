import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

export async function renderHome(root) {
  clear(root);
  const data = await api.get('/api/home');
  const p = data.person;

  const heroProgress = p.weekly_target_pts > 0
    ? Math.min(100, Math.round(((p.points_this_week || 0) / p.weekly_target_pts) * 100))
    : 0;

  const hero = el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['This week']),
    el('div', { class: 'big-num' }, [
      el('span', {}, [String(p.points_this_week || 0)]),
      el('span', { class: 'denom' }, [` / ${p.weekly_target_pts} pts`]),
    ]),
    el('div', { class: 'bar' }, [el('div', { class: 'bar-fill', style: { width: heroProgress + '%' } })]),
    el('div', { class: 'row spaced', style: { marginTop: '10px', fontSize: '0.78rem', color: 'var(--hero-muted)' } }, [
      el('span', {}, [`${p.streak_days || 0} day streak`]),
      el('span', {}, [`$${((p.bank_cents || 0) / 100).toFixed(2)} bank`]),
    ]),
  ]);

  const todaySection = el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Today']),
    ...(data.today.length === 0
      ? [el('p', { class: 'muted' }, ['Nothing left today.'])]
      : data.today.map(a => renderTask(a, root))),
  ]);

  const overdueSection = data.overdue.length === 0 ? null : el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Overdue']),
    ...data.overdue.map(a => renderTask(a, root, true)),
  ]);

  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
    ]),
    hero,
    todaySection,
    overdueSection,
    el('div', { class: 'row', style: { marginTop: 'var(--s5)' } }, [
      el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
    ]),
  ].filter(Boolean)));
}

function renderTask(a, root, overdue = false) {
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (overdue) classes.push('over');

  const ico = a.anti_cheat === 'photo' ? 'cam' : a.anti_cheat === 'approval' ? 'appr' : (a.status === 'done' ? 'done' : '');
  const icoText = a.anti_cheat === 'photo' ? 'P' : a.anti_cheat === 'approval' ? 'A' : (a.status === 'done' ? '✓' : a.title[0]);

  // Action affordance on the right depends on chore type + status.
  let action;
  if (a.status === 'done') {
    action = el('span', { class: 'pts' }, [`+${a.points}`]);
  } else if (a.anti_cheat === 'honor') {
    action = el('button', {
      class: 'btn btn-primary btn-done',
      onClick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post(`/api/assignments/${a.id}/done`);
          renderHome(root);
        } catch (err) {
          alert('Could not mark done: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = `Done · +${a.points}`;
        }
      },
    }, [`Done · +${a.points}`]);
  } else if (a.anti_cheat === 'photo') {
    action = el('span', { class: 'pill pill-warn' }, ['Needs photo']);
  } else if (a.anti_cheat === 'approval') {
    action = el('span', { class: 'pill pill-info' }, ['Needs approval']);
  } else {
    action = el('span', { class: 'pts' }, [`+${a.points}`]);
  }

  return el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('span', {}, [a.title]),
    ]),
    action,
  ]);
}

async function logout() {
  await api.post('/api/auth/logout');
  window.tallyNavigate('/');
}
