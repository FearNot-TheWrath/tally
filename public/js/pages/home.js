import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';
import { isMilestone, streakConfetti, milestoneConfetti } from '../lib/confetti.js';
import { pushStatus, enablePush } from '../lib/push-client.js';

function bonusHeat(b) {
  const min = b.min_points ?? b.points;
  const max = b.max_points ?? b.points;
  const cur = b.current_points ?? b.points;
  if (max <= min) return 'low';
  const pct = Math.max(0, Math.min(1, (cur - min) / (max - min)));
  if (pct <= 0.25) return 'low';
  if (pct <= 0.74) return 'mid';
  return 'high';
}
function bonusDisplayPoints(b) {
  return b.current_points ?? b.points;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtDueDateShort(iso) {
  const dt = new Date(iso + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return iso;
  return `${DAYS_SHORT[dt.getDay()]} ${MONTHS_SHORT[dt.getMonth()]} ${dt.getDate()}`;
}

export async function renderHome(root) {
  clear(root);
  const data = await api.get('/api/home');
  const p = data.person;

  const pct = Math.min(100, Math.round((p.percent || 0) * 100));
  const points = p.points_this_week || 0;
  const target = p.weekly_target_pts || 0;
  const projDollars = ((p.projected_pay_cents || 0) / 100).toFixed(2);

  const hero = el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['This week']),
    el('div', { class: 'big-num' }, [
      el('span', {}, [String(points)]),
      el('span', { class: 'denom' }, [` / ${target} pts · ${pct}%`]),
    ]),
    el('div', { class: 'bar' }, [el('div', { class: 'bar-fill', style: { width: pct + '%' } })]),
    el('div', { class: 'row spaced', style: { marginTop: '10px', fontSize: '0.78rem', color: 'var(--hero-muted)' } }, [
      el('span', {}, [`~$${projDollars} projected`]),
      el('span', {}, [`${p.streak_days || 0} day streak`]),
    ]),
    p.streak_at_risk
      ? el('div', { class: 'streak-at-risk', style: { marginTop: '8px' } }, ["Streak at risk — finish today's chores"])
      : null,
    p.on_freeze
      ? el('div', { class: 'streak-on-freeze', style: { marginTop: '8px' } }, ['On freeze — streak protected'])
      : null,
  ].filter(Boolean));

  const STREAK_KEY = 'tally_last_streak';
  const storedRaw = sessionStorage.getItem(STREAK_KEY);
  if (storedRaw !== null) {
    const lastStreak = parseInt(storedRaw, 10);
    if (p.streak_days > lastStreak) {
      if (isMilestone(p.streak_days)) milestoneConfetti(p.streak_days);
      else streakConfetti();
    }
  }
  sessionStorage.setItem(STREAK_KEY, String(p.streak_days));

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

  const bonusBoardSection = (data.bonuses && data.bonuses.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Bonus board']),
        ...data.bonuses.map(b => el('div', { class: 'txn bonus-row', 'data-heat': bonusHeat(b) }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'ico bonus-ico' }, ['★']),
            el('div', {}, [
              el('div', {}, [b.title]),
              b.description ? el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [b.description]) : null,
            ].filter(Boolean)),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/bonuses/${b.id}/claim`);
                renderHome(root);
              } catch (err) {
                if (err.status === 409) {
                  alert('Someone beat you to it.');
                } else {
                  alert('Could not claim: ' + err.message);
                }
                renderHome(root);
              }
            },
          }, [`Claim · +${bonusDisplayPoints(b)}`]),
        ])),
      ])
    : null;

  const coversSection = (data.covers && data.covers.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Cover for a sibling']),
        ...data.covers.map(s => el('div', { class: 'txn steal-row' }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'chip', style: { background: s.owner_color || '#0F172A' } }, [s.owner_name[0]]),
            el('div', {}, [
              el('div', {}, [s.title]),
              el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [`for ${s.owner_name}`]),
            ]),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/assignments/${s.id}/claim-cover`);
                renderHome(root);
              } catch (err) {
                if (err.status === 409) {
                  alert('Someone beat you to it.');
                } else {
                  alert('Could not claim: ' + err.message);
                }
                renderHome(root);
              }
            },
          }, [`Claim · +${s.display_points}`]),
        ])),
      ])
    : null;

  const stealSection = (data.stealable && data.stealable.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Steal from a sibling']),
        ...data.stealable.map(s => el('div', { class: 'txn steal-row' }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'chip', style: { background: s.owner_color || '#0F172A' } }, [s.owner_name[0]]),
            el('div', {}, [
              el('div', {}, [s.title]),
              el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [s.owner_name]),
            ]),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/assignments/${s.id}/steal`);
                renderHome(root);
              } catch (err) {
                alert('Could not claim: ' + err.message);
                e.target.disabled = false;
                e.target.textContent = `Claim · +${s.display_points}`;
              }
            },
          }, [`Claim · +${s.display_points}`]),
        ])),
      ])
    : null;

  const bankDollars = ((p.bank_cents || 0) / 100).toFixed(2);
  const bankSection = el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Bank']),
    el('div', { class: 'bank-balance', style: { color: p.bank_cents >= 0 ? 'var(--green)' : 'var(--red)' } }, [`$${bankDollars}`]),
    ...(p.transactions && p.transactions.length > 0
      ? p.transactions.map(t => {
          const d = t.created_at ? t.created_at.slice(5, 10).replace('-', '/') : '';
          const prefix = t.amount_cents >= 0 ? '+' : '';
          return el('div', { class: 'bank-txn' }, [
            el('span', { class: 'bank-txn-date' }, [d]),
            el('span', { class: 'bank-txn-note' }, [t.note || '']),
            el('span', {
              class: 'bank-txn-amt',
              style: { color: t.amount_cents >= 0 ? 'var(--green)' : 'var(--red)' },
            }, [`${prefix}$${(Math.abs(t.amount_cents) / 100).toFixed(2)}`]),
          ]);
        })
      : [el('p', { class: 'muted', style: { fontSize: '0.82rem' } }, ['No transactions yet.'])]
    ),
  ]);

  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        pushStatus() === 'default'
          ? el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = '…';
              const result = await enablePush();
              if (result.ok) {
                e.target.remove();
              } else if (result.reason === 'denied') {
                e.target.textContent = 'Reminders blocked';
              } else {
                e.target.remove();
              }
            }}, ['Turn on reminders'])
          : null,
        el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      ].filter(Boolean)),
    ]),
    hero,
    bankSection,
    todaySection,
    overdueSection,
    bonusBoardSection,
    coversSection,
    stealSection,
    el('div', { class: 'row', style: { marginTop: 'var(--s5)' } }, [
      el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
    ]),
  ].filter(Boolean)));
}

function renderTask(a, root, overdue = false) {
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (a.status === 'submitted') classes.push('submitted');
  if (a.status === 'excused') classes.push('excused');
  if (overdue) classes.push('over');
  if (a.is_bonus) classes.push('is-bonus');

  const ico = a.anti_cheat === 'photo' ? 'cam' : a.anti_cheat === 'approval' ? 'appr' : (a.status === 'done' ? 'done' : '');
  const icoText = a.anti_cheat === 'photo' ? 'P' : a.anti_cheat === 'approval' ? 'A' : (a.status === 'done' ? '✓' : a.title[0]);

  let action;
  if (a.status === 'excused') {
    action = el('span', { class: 'pill pill-info' }, ['Excused']);
  } else if (a.status === 'done') {
    // Honor chores are reversible by tapping the row again; photo/approval are not.
    const earned = a.forfeited === 1 ? 0 : a.display_points;
    if (a.anti_cheat === 'honor') {
      action = el('button', {
        class: 'btn btn-ghost btn-undo',
        title: 'Tap to undo',
        onClick: async (e) => {
          e.stopPropagation();
          e.target.disabled = true;
          try {
            await api.post(`/api/assignments/${a.id}/undo`);
            renderHome(root);
          } catch (err) {
            alert('Could not undo: ' + err.message);
            e.target.disabled = false;
          }
        },
      }, [`Undo · +${earned}`]);
    } else {
      action = el('span', { class: 'pts' }, [`+${earned}`]);
    }
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
          e.target.textContent = `Done · +${a.display_points}`;
        }
      },
    }, [`Done · +${a.display_points}`]);
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
          e.target.textContent = `Submit · +${a.display_points}`;
        }
      },
    }, [`Submit · +${a.display_points}`]);
  } else if (a.anti_cheat === 'photo') {
    const files = [];
    const thumbs = el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, []);
    const submitBtn = el('button', { class: 'btn btn-primary btn-done' }, [`Submit · +${a.display_points}`]);
    const addBtn = el('label', { class: 'btn btn-ghost btn-sm photo-btn' }, [
      'Add photo',
      el('input', {
        type: 'file', accept: 'image/*', capture: 'environment',
        style: { display: 'none' },
        onChange: (e) => {
          const f = e.target.files[0];
          e.target.value = '';
          if (!f || files.length >= 3) return;
          files.push(f);
          thumbs.appendChild(el('img', {
            src: URL.createObjectURL(f),
            style: { width: '40px', height: '40px', objectFit: 'cover', borderRadius: 'var(--r-sm)' },
          }));
          sync();
        },
      }),
    ]);
    function sync() {
      submitBtn.disabled = files.length === 0;
      addBtn.style.display = files.length >= 3 ? 'none' : '';
    }
    submitBtn.onclick = async () => {
      if (files.length === 0) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading…';
      const fd = new FormData();
      for (const f of files) fd.append('photo', f);
      try {
        const res = await fetch(`/api/assignments/${a.id}/submit`, {
          method: 'POST', credentials: 'same-origin', body: fd,
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
        renderHome(root);
      } catch (err) {
        alert('Upload failed: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = `Submit · +${a.display_points}`;
      }
    };
    sync();
    action = el('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, [thumbs, addBtn, submitBtn]);
  }

  const stolenBadge = a.stolen_from_name
    ? el('span', { class: 'pill pill-info', style: { fontSize: '0.62rem', marginLeft: '6px' } }, [`from ${a.stolen_from_name}`])
    : null;
  const bonusBadge = a.is_bonus
    ? el('span', { class: 'pill pill-warn', style: { fontSize: '0.62rem', marginLeft: '6px' } }, ['★ bonus'])
    : null;
  const forfeitedBadge = a.forfeited === 1
    ? el('span', { class: 'pill pill-warn', style: { fontSize: '0.62rem', marginLeft: '6px' }, title: 'School-work missed deadline — points forfeited' }, ['Late'])
    : null;

  const giveBack = (a.is_bonus && a.status === 'pending')
    ? el('button', {
        class: 'btn btn-ghost btn-undo',
        title: 'Give this bonus back so someone else can claim it',
        onClick: async (e) => {
          e.stopPropagation();
          e.target.disabled = true;
          try {
            await api.post(`/api/assignments/${a.id}/unclaim`);
            renderHome(root);
          } catch (err) {
            alert('Could not give back: ' + err.message);
            e.target.disabled = false;
          }
        },
      }, ['Give back'])
    : null;

  return el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('div', {}, [
        el('span', {}, [a.title]),
        stolenBadge,
        bonusBadge,
        forfeitedBadge,
        overdue
          ? el('div', { style: { fontSize: '0.7rem', color: 'var(--red)', opacity: 0.85 } }, [
              `was due ${fmtDueDateShort(a.due_date)}`,
            ])
          : null,
        a.status === 'excused' && a.note
          ? el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [a.note])
          : null,
      ].filter(Boolean)),
    ]),
    giveBack ? el('div', { class: 'row', style: { gap: '6px' } }, [giveBack, action]) : action,
  ]);
}

async function logout() {
  await api.post('/api/auth/logout');
  window.tallyNavigate('/');
}
