import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'bonuses',    label: 'Bonus board', render: renderBonuses },
  { key: 'bank',       label: 'Bank',       render: renderBank },
  { key: 'people',     label: 'People',     render: renderPeople },
  { key: 'chores',     label: 'Chores',     render: renderChores },
  { key: 'settings',   label: 'Settings',   render: renderSettings },
];

export async function renderAdmin(root) {
  const me = await api.get('/api/me').catch(() => null);
  if (!me || me.role !== 'parent') { window.tallyNavigate('/'); return; }

  let active = location.hash.replace('#','') || 'today';
  if (!TABS.find(t => t.key === active)) active = 'today';

  const tabsBar = el('nav', { class: 'admin-tabs' },
    TABS.map(t => el('button', {
      class: 'admin-tab' + (t.key === active ? ' active' : ''),
      onClick: () => { location.hash = '#' + t.key; renderAdmin(root); },
    }, [t.label]))
  );

  const content = el('div', {});

  const shell = el('div', { class: 'page wide stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, ['Tally · Admin']),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
      ]),
    ]),
    tabsBar,
    content,
  ]);

  // Clear immediately before append to defeat the concurrent-render race:
  // a tap that fires twice (or a tab click during /me await) used to leave
  // both DOM trees attached. Clearing here means whichever render finishes
  // last wins; earlier appends are wiped.
  clear(root);
  root.appendChild(shell);

  await TABS.find(t => t.key === active).render(content);
}

async function logout() {
  await api.post('/api/auth/logout');
  window.tallyNavigate('/');
}

/* ───── Today tab ───── */
async function renderToday(host) {
  clear(host);
  const d = await api.get('/api/admin/today');
  host.appendChild(el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['House progress today']),
    el('div', { class: 'big-num' }, [String(d.house_pct), el('span', { class: 'denom' }, ['%'])]),
    el('div', { style: { marginTop: '10px', color: 'var(--hero-muted)', fontSize: '0.85rem' } }, [
      `${d.done} of ${d.total} chores done across the family`
    ]),
  ]));
  host.appendChild(el('div', { class: 'stack', style: { marginTop: 'var(--s4)' } },
    d.kids.map(k => {
      const detail = el('div', { class: 'stack', style: { display: 'none', marginTop: '8px', gap: '4px' } },
        (k.assignments || []).map(a => {
          const right = a.status === 'excused'
            ? el('span', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
                el('span', { style: { fontSize: '0.72rem', color: '#5B21B6' } }, [`Excused: ${a.note || ''}`]),
                el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
                  e.stopPropagation();
                  try { await api.post(`/api/admin/assignments/${a.id}/unexcuse`, {}); renderToday(host); }
                  catch (err) { alert(err.message); }
                }}, ['Undo']),
              ])
            : el('span', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
                el('span', { style: { fontSize: '0.72rem', color: 'var(--muted)' } }, [
                  a.due_date !== d.today ? 'overdue' : a.status,
                ]),
                a.status !== 'done'
                  ? el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
                      e.stopPropagation();
                      const reason = prompt(`Why is "${a.title}" excused?`, '');
                      if (reason === null) return;
                      try { await api.post(`/api/admin/assignments/${a.id}/excuse`, { note: reason }); renderToday(host); }
                      catch (err) { alert(err.message); }
                    }}, ['Excuse'])
                  : null,
              ].filter(Boolean));
          return el('div', {
            style: {
              fontSize: '0.82rem',
              padding: '4px 8px',
              borderRadius: 'var(--r-sm)',
              background: a.status === 'done' ? 'var(--card-muted)' : 'transparent',
              color: a.status === 'done' ? 'var(--muted)' : 'var(--ink)',
              textDecoration: a.status === 'done' ? 'line-through' : 'none',
              opacity: a.status === 'excused' ? 0.7 : 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            },
          }, [
            el('span', {}, [a.title]),
            right,
          ]);
        })
      );
      return el('div', { class: 'list-row', style: { cursor: 'pointer', display: 'block' }, onClick: () => {
        detail.style.display = detail.style.display === 'none' ? 'flex' : 'none';
      }}, [
        el('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center' } }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'av', style: { background: k.avatar_color } }, [k.name[0]]),
            el('div', {}, [
              el('div', { style: { fontWeight: 600 } }, [k.name]),
              el('div', { class: 'muted', style: { fontSize: '0.82rem' } }, [
                `${k.today_done}/${k.today_total} today` + (k.overdue ? ` · ${k.overdue} overdue` : ''),
              ]),
              el('div', { class: 'muted', style: { fontSize: '0.82rem' } }, [
                `${k.points} pts · ~$${((k.projected_pay_cents || 0) / 100).toFixed(2)} this week · bank $${((k.bank_cents || 0) / 100).toFixed(2)}`,
              ]),
            ]),
          ]),
          el('span', { class: 'num pts' }, [`${k.today_total === 0 ? 100 : Math.round(k.today_done / k.today_total * 100)}%`]),
        ]),
        detail,
      ]);
    })
  ));
}

/* ───── People tab ───── */
async function renderPeople(host) {
  clear(host);
  const { people } = await api.get('/api/admin/people');
  const todayIso = new Date().toISOString().slice(0, 10);
  const isFrozen = (p) => p.freeze_start && p.freeze_end
    && todayIso >= p.freeze_start && todayIso <= p.freeze_end;
  const rows = people.map(p => el('div', { class: 'list-row', onClick: () => editPerson(p, host) }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      el('div', {}, [
        el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          el('span', { style: { fontWeight: 600 } }, [p.name]),
          isFrozen(p) ? el('span', { class: 'pill pill-info', style: { fontSize: '0.65rem' } }, ['On freeze']) : null,
        ].filter(Boolean)),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [`${p.role} · target ${p.weekly_target_pts}`]),
      ]),
    ]),
    el('button', { class: 'btn btn-ghost' }, ['Edit']),
  ]));
  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['People']),
    el('button', { class: 'btn btn-primary', onClick: () => editPerson(null, host) }, ['+ Add']),
  ]));
  host.appendChild(el('div', { class: 'stack' }, rows));
}

function editPerson(person, host) {
  const isNew = !person;
  const data = person ? { ...person } : { role: 'kid', avatar_color: '#22C55E' };

  const fields = [
    ['name', 'Name', 'text'],
    ['role', 'Role', 'select', ['kid', 'parent']],
    ['dob', 'Date of birth', 'date'],
    ['avatar_color', 'Avatar color (hex)', 'text'],
    ['weekly_target_pts', 'Weekly target (pts)', 'number'],
    ['base_pay_cents', 'Base pay when target is hit ($)', 'money'],
    ['bonus_rate_cents', 'Bonus per extra point ($)', 'money'],
    ['freeze_start', 'Freeze start (sick day, vacation)', 'date'],
    ['freeze_end', 'Freeze end', 'date'],
  ];

  const inputs = fields.map(([key, label, type, opts]) => {
    const id = `f_${key}`;
    let input;
    if (type === 'select') {
      input = el('select', { id, onChange: e => data[key] = e.target.value },
        opts.map(o => el('option', { value: o, selected: data[key] === o }, [o])));
    } else if (type === 'money') {
      const dollars = data[key] != null ? (data[key] / 100).toFixed(2) : '';
      input = el('input', {
        id, type: 'number', step: '0.01', min: '0',
        value: dollars,
        onInput: e => {
          const v = e.target.value;
          data[key] = v === '' ? 0 : Math.round(parseFloat(v) * 100);
        },
      });
    } else {
      input = el('input', {
        id, type,
        value: data[key] != null ? String(data[key]) : '',
        onInput: e => data[key] = type === 'number' ? Number(e.target.value) : e.target.value,
      });
    }
    return el('div', { class: 'form-field' }, [el('label', { for: id }, [label]), input]);
  });

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [isNew ? 'Add person' : `Edit ${person.name}`]),
      ...inputs,
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onClick: async () => {
          try {
            if (isNew) await api.post('/api/admin/people', data);
            else await api.patch(`/api/admin/people/${person.id}`, data);
            modal.remove();
            await renderPeople(host);
          } catch (e) { alert(e.message); }
        }}, ['Save']),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}

/* ───── Chores tab ───── */
async function renderChores(host) {
  clear(host);
  const [{ chores }, { people }] = await Promise.all([
    api.get('/api/admin/chores'),
    api.get('/api/admin/people'),
  ]);
  const kids = people.filter(p => p.role === 'kid');

  const rows = chores.map(c => {
    const assignees = (c.default_assignees || '').split(',').filter(Boolean)
      .map(id => kids.find(k => k.id === parseInt(id, 10)))
      .filter(Boolean);
    const assigneeChips = assignees.length === 0
      ? [el('span', { class: 'muted', style: { fontSize: '0.72rem', fontStyle: 'italic' } }, ['unassigned'])]
      : assignees.map(k => el('span', {
          class: 'chip',
          title: k.name,
          style: { background: k.avatar_color },
        }, [k.name[0]]));
    return el('div', { class: 'list-row', onClick: () => editChore(c, host, kids) }, [
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [c.title]),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `${c.recurs} · ${c.anti_cheat} · weight ${'●'.repeat(c.weight || 3)}${'○'.repeat(5 - (c.weight || 3))}${c.unstealable ? ' · (no steal)' : ''}`
        ]),
        el('div', { class: 'row', style: { gap: '4px', marginTop: '6px', flexWrap: 'wrap' } }, assigneeChips),
      ]),
      el('button', { class: 'btn btn-ghost' }, ['Edit']),
    ]);
  });
  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['Chores']),
    el('button', { class: 'btn btn-primary', onClick: () => editChore(null, host, kids) }, ['+ Add']),
  ]));
  host.appendChild(el('div', { class: 'stack' }, rows));
}

function editChore(chore, host, kids) {
  const isNew = !chore;
  const data = chore ? { ...chore } : {
    title: '', points: 5, weight: 3, unstealable: 0,
    kind: 'recurring', recurs: 'daily', anti_cheat: 'honor',
    default_assignees: '', recurs_days: '',
  };
  const assigneeSet = new Set((data.default_assignees || '').split(',').filter(Boolean).map(Number));

  const fields = [
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Title']),
      el('input', { value: data.title, onInput: e => data.title = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Points']),
      el('input', { type: 'number', value: data.points, onInput: e => data.points = Number(e.target.value) }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Weight (effort)']),
      el('select', { onChange: e => data.weight = Number(e.target.value) },
        [1,2,3,4,5].map(w => el('option', { value: w, selected: data.weight === w }, [String(w) + (w === 1 ? ' — very light' : w === 5 ? ' — very heavy' : '')]))
      ),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: data.unstealable === 1,
          onChange: e => { data.unstealable = e.target.checked ? 1 : 0; },
        }),
        el('span', {}, ['Unstealable: siblings cannot steal it']),
      ]),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Recurs']),
      el('select', { onChange: e => data.recurs = e.target.value },
        ['daily','weekly','biweekly','monthly','none'].map(o =>
          el('option', { value: o, selected: data.recurs === o }, [o]))),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Days of week (0=Sun..6=Sat, comma-separated; weekly/biweekly only)']),
      el('input', { value: data.recurs_days || '', onInput: e => data.recurs_days = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Anti-cheat']),
      el('select', { onChange: e => data.anti_cheat = e.target.value },
        ['honor','photo','approval'].map(o =>
          el('option', { value: o, selected: data.anti_cheat === o }, [o]))),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Assigned to']),
      el('div', { class: 'row' },
        kids.map(k => el('label', { class: 'row', style: { gap: '6px', marginRight: '12px' } }, [
          el('input', {
            type: 'checkbox',
            checked: assigneeSet.has(k.id),
            onChange: e => {
              if (e.target.checked) assigneeSet.add(k.id); else assigneeSet.delete(k.id);
              data.default_assignees = [...assigneeSet].join(',');
            },
          }),
          k.name,
        ]))),
    ]),
  ];

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [isNew ? 'New chore' : `Edit ${chore.title}`]),
      ...fields,
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        chore ? el('button', { class: 'btn btn-danger', onClick: async () => {
          if (!confirm(`Delete ${chore.title}?`)) return;
          await api.del(`/api/admin/chores/${chore.id}`);
          modal.remove();
          await renderChores(host);
        }}, ['Delete']) : el('span', {}, ['']),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
          el('button', { class: 'btn btn-primary', onClick: async () => {
            try {
              if (isNew) await api.post('/api/admin/chores', data);
              else await api.patch(`/api/admin/chores/${chore.id}`, data);
              modal.remove();
              await renderChores(host);
            } catch (e) { alert(e.message); }
          }}, ['Save']),
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}

/* ───── Approvals tab ───── */
async function renderApprovals(host) {
  clear(host);
  const { approvals } = await api.get('/api/admin/approvals');

  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['Pending approvals']),
    el('span', { class: 'muted' }, [`${approvals.length} waiting`]),
  ]));

  if (approvals.length === 0) {
    host.appendChild(el('p', { class: 'muted' }, ['Nothing to review. Nice.']));
    return;
  }

  const list = el('div', { class: 'stack' },
    approvals.map(a => renderApprovalCard(a, host))
  );
  host.appendChild(list);
}

function renderApprovalCard(a, host) {
  const card = el('div', { class: 'approval-card' }, [
    el('div', { class: 'row spaced' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'chip', style: { background: a.kid_color || '#0F172A' } }, [a.kid_name[0]]),
        el('div', {}, [
          el('div', { style: { fontWeight: 600 } }, [a.chore_title]),
          el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
            `${a.kid_name} · ${a.chore_points} pts · submitted ${a.submitted_at}`
          ]),
        ]),
      ]),
    ]),
    (a.photos && a.photos.length)
      ? el('div', { class: 'photo-thumbs' }, a.photos.map(url =>
          el('a', { href: url, target: '_blank' }, [
            el('img', { class: 'photo-thumb', src: url, alt: a.chore_title }),
          ])))
      : null,
    a.note ? el('div', { class: 'approval-note' }, [a.note]) : null,
    el('div', { class: 'row spaced approval-actions' }, [
      el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          const note = prompt('Reject reason (optional):') || '';
          if (note === null) return;
          await api.post(`/api/admin/approvals/${a.id}/reject`, { note });
          await renderApprovals(host);
        },
      }, ['Reject']),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn btn-ghost',
          onClick: async () => {
            const ptsStr = prompt(`Award how many points? (default ${a.chore_points}):`, String(a.chore_points));
            if (ptsStr === null) return;
            const pts = parseInt(ptsStr, 10);
            if (!Number.isFinite(pts) || pts < 0) { alert('Bad number'); return; }
            await api.post(`/api/admin/approvals/${a.id}/approve`, { points: pts });
            await renderApprovals(host);
          },
        }, ['Approve with…']),
        el('button', {
          class: 'btn btn-primary',
          onClick: async () => {
            await api.post(`/api/admin/approvals/${a.id}/approve`);
            await renderApprovals(host);
          },
        }, [`Approve · +${a.chore_points}`]),
      ]),
    ]),
  ].filter(Boolean));
  return card;
}

/* ───── Day Review tab ───── */
async function renderDayReview(host, dateOverride = null) {
  clear(host);
  const todayIso = new Date().toISOString().slice(0, 10);
  const date = dateOverride || todayIso;

  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s4)' } }, [
    el('h3', {}, ['Day review']),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onClick: () => shiftDay(date, -1, host),
      }, ['‹ Prev']),
      el('input', {
        type: 'date', value: date,
        class: 'date-picker',
        onChange: (e) => renderDayReview(host, e.target.value),
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onClick: () => shiftDay(date, 1, host),
      }, ['Next ›']),
    ]),
  ]));

  let data;
  try {
    data = await api.get(`/api/admin/day-review?date=${date}`);
  } catch (e) {
    host.appendChild(el('p', { class: 'red' }, ['Failed to load: ' + e.message]));
    return;
  }

  if (data.items.length === 0) {
    host.appendChild(el('p', { class: 'muted' }, ['No photo or approval chores assigned for this day.']));
    return;
  }

  // Group by kid for readability
  const byKid = {};
  for (const it of data.items) {
    if (!byKid[it.kid_id]) byKid[it.kid_id] = { name: it.kid_name, color: it.kid_color, items: [] };
    byKid[it.kid_id].items.push(it);
  }

  for (const kid of Object.values(byKid)) {
    host.appendChild(el('div', { class: 'row', style: { marginTop: 'var(--s4)', marginBottom: 'var(--s2)', gap: '8px' } }, [
      el('div', { class: 'chip', style: { background: kid.color } }, [kid.name[0]]),
      el('h4', {}, [kid.name]),
      el('span', { class: 'muted', style: { fontSize: '0.8rem' } }, [
        `${kid.items.filter(i => i.status === 'done').length}/${kid.items.length} done`,
      ]),
    ]));

    host.appendChild(el('div', { class: 'stack' },
      kid.items.map(it => renderDayReviewRow(it, host, date))
    ));
  }
}

function shiftDay(currentDateIso, deltaDays, host) {
  const d = new Date(currentDateIso + 'T00:00:00');
  d.setDate(d.getDate() + deltaDays);
  const next = d.toISOString().slice(0, 10);
  renderDayReview(host, next);
}

function renderDayReviewRow(it, host, date) {
  const statusBadge = ({
    pending: el('span', { class: 'pill pill-warn' }, ['Not submitted']),
    submitted: el('span', { class: 'pill pill-info' }, ['Waiting']),
    done: el('span', { class: 'pill pill-success' }, ['Done']),
    rejected: el('span', { class: 'pill pill-danger' }, ['Rejected']),
    expired: el('span', { class: 'pill' }, ['Expired']),
  })[it.status] || el('span', { class: 'pill' }, [it.status]);

  const meta = [];
  if (it.status === 'done' && it.approver_name) meta.push(`Approved by ${it.approver_name}`);
  if (it.status === 'rejected' && it.note) meta.push(`Rejected: ${it.note}`);
  if (it.status === 'submitted' && it.submitted_at) meta.push(`Submitted ${it.submitted_at}`);

  return el('div', { class: 'review-row' }, [
    el('div', { class: 'review-row-main' }, [
      el('div', { class: 'row spaced' }, [
        el('div', {}, [
          el('div', { style: { fontWeight: 600 } }, [it.chore_title]),
          el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
            `${it.anti_cheat} · ${it.chore_points} pts${meta.length ? ' · ' + meta.join(' · ') : ''}`,
          ]),
        ]),
        statusBadge,
      ]),
      (it.photos && it.photos.length)
        ? el('div', { class: 'photo-thumbs' }, it.photos.map(url =>
            el('a', { href: url, target: '_blank' }, [
              el('img', { class: 'photo-thumb', src: url, alt: it.chore_title }),
            ])))
        : null,
      it.status === 'submitted' ? el('div', { class: 'row spaced', style: { marginTop: '8px' } }, [
        el('button', {
          class: 'btn btn-danger btn-sm',
          onClick: async () => {
            const note = prompt('Reject reason (optional):') || '';
            await api.post(`/api/admin/approvals/${it.id}/reject`, { note });
            renderDayReview(host, date);
          },
        }, ['Reject']),
        el('button', {
          class: 'btn btn-primary btn-sm',
          onClick: async () => {
            await api.post(`/api/admin/approvals/${it.id}/approve`);
            renderDayReview(host, date);
          },
        }, [`Approve · +${it.chore_points}`]),
      ]) : null,
    ].filter(Boolean)),
  ]);
}

/* ───── Settings tab ───── */
async function renderSettings(host) {
  clear(host);
  const data = await api.get('/api/admin/settings');
  const s = data.settings;

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Settings']));

  const timeField = (key, defaultVal, label, hint) => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'time',
      value: s[key] || defaultVal,
      onChange: async (e) => {
        const value = e.target.value;
        try {
          await api.patch(`/api/admin/settings/${key}`, { value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) {
          alert('Save failed: ' + err.message);
        }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [hint]),
  ]);

  host.appendChild(timeField(
    'steal_unlock_time', '16:00',
    'Steal unlock time (24-hour local)',
    "Time of day after which kids can claim siblings' pending stealable chores.",
  ));
  host.appendChild(timeField(
    'streak_warning_time', '20:00',
    'Streak warning time (24-hour local)',
    'After this time, a kid with an incomplete day and an active streak sees a "Streak at risk" warning.',
  ));

  const dayField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Payout day']),
    el('select', {
      onChange: async (e) => {
        try {
          await api.patch('/api/admin/settings/payout_day', { value: e.target.value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }, ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(d =>
      el('option', { value: d, selected: (s.payout_day || 'sunday') === d }, [d.charAt(0).toUpperCase() + d.slice(1)])
    )),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'Day of week when weekly earnings are deposited into kid balances.',
    ]),
  ]);

  host.appendChild(dayField);
  host.appendChild(timeField(
    'payout_time', '20:00',
    'Payout time (24-hour local)',
    'Time on payout day when the deposit happens (on next app visit after this time).',
  ));
}

/* ───── Bank tab ───── */
async function renderBank(host) {
  clear(host);
  const { kids } = await api.get('/api/admin/bank');

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Bank']));

  for (const kid of kids) {
    const dollars = ((kid.bank_cents || 0) / 100).toFixed(2);
    const card = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
      el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'av', style: { background: kid.avatar_color } }, [kid.name[0]]),
          el('div', {}, [
            el('div', { style: { fontWeight: 600 } }, [kid.name]),
            el('div', { style: { fontFamily: 'var(--font-num)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--green)' } }, [`$${dollars}`]),
          ]),
        ]),
        el('button', { class: 'btn btn-primary', onClick: () => adjustModal(kid, host) }, ['Adjust']),
      ]),
      ...(kid.transactions.length > 0
        ? kid.transactions.map(t => {
            const d = t.created_at ? t.created_at.slice(0, 10) : '';
            const amt = (Math.abs(t.amount_cents) / 100).toFixed(2);
            const prefix = t.amount_cents >= 0 ? '+' : '-';
            const color = t.amount_cents >= 0 ? 'var(--green)' : 'var(--red)';
            return el('div', { class: 'bank-txn' }, [
              el('span', { class: 'bank-txn-date' }, [d]),
              el('span', { class: 'bank-txn-note' }, [t.note || '']),
              el('span', { class: 'bank-txn-amt', style: { color } }, [`${prefix}$${amt}`]),
            ]);
          })
        : [el('p', { class: 'muted', style: { fontSize: '0.82rem' } }, ['No transactions yet.'])]
      ),
    ]);
    host.appendChild(card);
  }
}

function adjustModal(kid, host) {
  let amountVal = '';
  let noteVal = '';

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [`Adjust ${kid.name}'s balance`]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Amount ($)']),
        el('input', { type: 'number', step: '0.01', min: '0', placeholder: '5.00', onInput: e => amountVal = e.target.value }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Note (required)']),
        el('input', { type: 'text', placeholder: 'Bought a book', onInput: e => noteVal = e.target.value }),
      ]),
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-danger', onClick: async () => {
            const cents = Math.round(parseFloat(amountVal) * 100);
            if (!cents || !noteVal.trim()) { alert('Amount and note required'); return; }
            try {
              await api.post(`/api/admin/bank/${kid.id}/adjust`, { amount_cents: -cents, note: noteVal.trim() });
              modal.remove();
              renderBank(host);
            } catch (e) { alert(e.message); }
          }}, ['Deduct']),
          el('button', { class: 'btn btn-primary', onClick: async () => {
            const cents = Math.round(parseFloat(amountVal) * 100);
            if (!cents || !noteVal.trim()) { alert('Amount and note required'); return; }
            try {
              await api.post(`/api/admin/bank/${kid.id}/adjust`, { amount_cents: cents, note: noteVal.trim() });
              modal.remove();
              renderBank(host);
            } catch (e) { alert(e.message); }
          }}, ['Add']),
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}

/* ───── Bonus Board tab ───── */
async function renderBonuses(host) {
  clear(host);

  const form = {
    title: '',
    points: 10,
    anti_cheat: 'honor',
    description: '',
    photo_prompt: '',
  };

  const { people } = await api.get('/api/admin/people');
  const kids = people.filter(p => p.role === 'kid');
  const costLine = el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, []);
  function updateBonusCost() {
    const pts = Number(form.points) || 0;
    costLine.textContent = kids.length === 0
      ? 'No kids configured.'
      : 'Cost if claimed:  ' + kids.map(k => `${k.name} $${(pts * (k.bonus_rate_cents || 0) / 100).toFixed(2)}`).join('   ·   ');
  }
  updateBonusCost();

  const photoPromptField = el('div', { class: 'form-field', style: { display: 'none' } }, [
    el('label', {}, ['Photo prompt (shown to the kid)']),
    el('input', { type: 'text', value: form.photo_prompt, onInput: e => form.photo_prompt = e.target.value }),
  ]);
  const antiCheatSelect = el('select', {
    onChange: e => {
      form.anti_cheat = e.target.value;
      photoPromptField.style.display = e.target.value === 'photo' ? 'flex' : 'none';
    },
  }, ['honor', 'photo', 'approval'].map(o =>
    el('option', { value: o, selected: form.anti_cheat === o }, [o])));

  const formCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h3', { style: { marginBottom: 'var(--s3)' } }, ['Post a bonus']),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Title']),
      el('input', { type: 'text', placeholder: 'Mow lawn', onInput: e => form.title = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Points']),
      el('input', { type: 'number', value: form.points, min: '1', onInput: e => { form.points = Number(e.target.value); updateBonusCost(); } }),
      costLine,
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Anti-cheat']),
      antiCheatSelect,
    ]),
    photoPromptField,
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Description (optional)']),
      el('textarea', { rows: 2, onInput: e => form.description = e.target.value }),
    ]),
    el('button', {
      class: 'btn btn-primary',
      onClick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post('/api/admin/bonuses', form);
          renderBonuses(host);
        } catch (err) {
          alert('Post failed: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = 'Post bonus';
        }
      },
    }, ['Post bonus']),
  ]);
  host.appendChild(formCard);

  const data = await api.get('/api/admin/bonuses');
  host.appendChild(el('h3', { style: { marginBottom: 'var(--s3)' } }, [
    `${data.bonuses.length} bonus${data.bonuses.length === 1 ? '' : 'es'}`,
  ]));

  if (data.bonuses.length === 0) {
    host.appendChild(el('p', { class: 'muted' }, ['No bonuses posted.']));
    return;
  }

  host.appendChild(el('div', { class: 'stack' },
    data.bonuses.map(b => renderBonusRow(b, host))
  ));
}

function renderBonusRow(b, host) {
  const statusText = b.claimed_by
    ? `Claimed by ${b.claimed_by_name} · ${b.assignment_status}`
    : 'Unclaimed';
  const statusClass = b.claimed_by
    ? (b.assignment_status === 'done' ? 'pill-success'
       : b.assignment_status === 'rejected' ? 'pill-danger'
       : 'pill-info')
    : 'pill-warn';

  const actions = [];
  if (!b.claimed_by) {
    actions.push(el('button', {
      class: 'btn btn-danger btn-sm',
      onClick: async () => {
        if (!confirm(`Cancel bonus "${b.title}"?`)) return;
        await api.del(`/api/admin/bonuses/${b.id}`);
        renderBonuses(host);
      },
    }, ['Cancel']));
  }

  return el('div', { class: 'review-row' }, [
    el('div', { class: 'row spaced' }, [
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [b.title]),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `+${b.points} pts · ${b.anti_cheat}${b.description ? ' · ' + b.description : ''}`,
        ]),
      ]),
      el('span', { class: 'pill ' + statusClass }, [statusText]),
    ]),
    actions.length > 0 ? el('div', { class: 'row spaced approval-actions' }, actions) : null,
  ].filter(Boolean));
}
