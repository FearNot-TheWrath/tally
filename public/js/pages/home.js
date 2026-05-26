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
  if (a.status === 'submitted') classes.push('submitted');
  if (overdue) classes.push('over');

  const ico = a.anti_cheat === 'photo' ? 'cam' : a.anti_cheat === 'approval' ? 'appr' : (a.status === 'done' ? 'done' : '');
  const icoText = a.anti_cheat === 'photo' ? 'P' : a.anti_cheat === 'approval' ? 'A' : (a.status === 'done' ? '✓' : a.title[0]);

  let action;
  if (a.status === 'done') {
    action = el('span', { class: 'pts' }, [`+${a.points}`]);
  } else if (a.status === 'submitted') {
    action = el('span', { class: 'pill pill-info' }, ['Waiting for parent']);
  } else if (a.anti_cheat === 'honor') {
    action = el('button', {
      class: 'btn btn-primary btn-done',
      onClick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post(`/api/assignments/${a.id}/submit`);
          renderHome(root);
        } catch (err) {
          alert('Could not mark done: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = `Done · +${a.points}`;
        }
      },
    }, [`Done · +${a.points}`]);
  } else if (a.anti_cheat === 'approval') {
    action = el('button', {
      class: 'btn btn-primary btn-done',
      onClick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post(`/api/assignments/${a.id}/submit`);
          renderHome(root);
        } catch (err) {
          alert('Could not submit: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = `Submit · +${a.points}`;
        }
      },
    }, [`Submit · +${a.points}`]);
  } else if (a.anti_cheat === 'photo') {
    action = el('label', { class: 'btn btn-primary btn-done photo-btn' }, [
      `Photo · +${a.points}`,
      el('input', {
        type: 'file', accept: 'image/*', capture: 'environment',
        style: { display: 'none' },
        onChange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const btn = e.target.parentElement;
          btn.classList.add('btn-loading');
          btn.firstChild.nodeValue = 'Uploading…';
          const fd = new FormData();
          fd.append('photo', file);
          try {
            const res = await fetch(`/api/assignments/${a.id}/submit`, {
              method: 'POST', credentials: 'same-origin', body: fd,
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || res.statusText);
            }
            renderHome(root);
          } catch (err) {
            alert('Upload failed: ' + err.message);
            btn.classList.remove('btn-loading');
            btn.firstChild.nodeValue = `Photo · +${a.points}`;
          }
        },
      }),
    ]);
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
