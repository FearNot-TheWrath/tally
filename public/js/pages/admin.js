import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'bonuses',    label: 'Bonus board', render: renderBonuses },
  { key: 'wall',       label: 'Wall',       render: renderWall },
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
    ['streak_credit', 'Streak credit (extra days added to displayed streak)', 'number'],
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
    title: '', points: 5, weight: 3, unstealable: 0, is_school_work: 0,
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
    // Bonus ripening fields (only visible when kind=bonus).
    ...(data.kind === 'bonus' ? [
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Min points (starting value when posted)']),
        el('input', {
          type: 'number', min: '1',
          value: data.min_points ?? data.points,
          onInput: e => data.min_points = Number(e.target.value),
        }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Max points (cap before bonus disappears)']),
        el('input', {
          type: 'number', min: '1',
          value: data.max_points ?? data.points,
          onInput: e => data.max_points = Number(e.target.value),
        }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Days to ripen']),
        el('input', {
          type: 'number', min: '1', max: '30',
          value: data.days_to_ripen ?? 5,
          onInput: e => data.days_to_ripen = Number(e.target.value),
        }),
        el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
          'How many days the value takes to climb from min to max. After it stays at max for one day, the bonus disappears.',
        ]),
      ]),
    ] : []),
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
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: data.is_school_work === 1,
          onChange: e => { data.is_school_work = e.target.checked ? 1 : 0; },
        }),
        el('span', {}, ['School work: forfeits points if not done by the school deadline']),
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

/* ───── Wall tab ───── */
async function renderWall(host) {
  clear(host);
  const data = await api.get('/api/admin/settings');
  const s = data.settings;

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Wall']));

  // ------- Card 1: Panels -------
  const enabledRaw = (s.wall_enabled_panels || 'chores,weather,calendar,verse-fact').split(',').map(p => p.trim());
  const enabledSet = new Set(enabledRaw);
  const PANELS = [
    { k: 'chores',     label: 'Chores wall',         locked: true },
    { k: 'weather',    label: 'Weather',             locked: false },
    { k: 'calendar',   label: 'Calendar (v0.15.0)',  locked: false },
    { k: 'verse-fact', label: 'Verse / Fact',        locked: false },
  ];

  const panelsCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Panels']),
    el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px' } },
      PANELS.map(p => {
        const cb = el('input', {
          type: 'checkbox',
          checked: (enabledSet.has(p.k) || p.locked) ? 'checked' : null,
          disabled: p.locked ? 'disabled' : null,
          onChange: async (e) => {
            if (e.target.checked) enabledSet.add(p.k); else enabledSet.delete(p.k);
            enabledSet.add('chores');
            try { await api.patch('/api/admin/settings/wall_enabled_panels', { value: [...enabledSet].join(',') }); renderWall(host); }
            catch (err) { alert('Save failed: ' + err.message); e.target.checked = !e.target.checked; }
          },
        });
        return el('label', { class: 'row', style: { gap: '6px', cursor: p.locked ? 'not-allowed' : 'pointer' } }, [cb, p.label]);
      })
    ),
    el('div', { class: 'form-field', style: { marginTop: 'var(--s3)' } }, [
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: (s.wall_smart_cycle || 'on') === 'on' ? 'checked' : null,
          onChange: async (e) => {
            const value = e.target.checked ? 'on' : 'off';
            try { await api.patch('/api/admin/settings/wall_smart_cycle', { value }); }
            catch (err) { alert('Save failed: ' + err.message); e.target.checked = !e.target.checked; }
          },
        }),
        el('span', {}, ['Smart cycle (chores between each other panel)']),
      ]),
    ]),
  ]);
  host.appendChild(panelsCard);

  // ------- Card 2: Rotation timing -------
  const dwellState = {
    chores:     Number(s.wall_chores_dwell_sec   || 60),
    weather:    Number(s.wall_weather_dwell_sec  || 15),
    calendar:   Number(s.wall_calendar_dwell_sec || 15),
    'verse-fact': Number(s.wall_verse_dwell_sec  || 15),
  };
  function pctBadge(k) {
    const enabled = PANELS.filter(p => enabledSet.has(p.k) || p.locked).map(p => p.k);
    let total = 0;
    for (const e of enabled) total += dwellState[e] || 0;
    if (!total) return '0%';
    const v = dwellState[k] || 0;
    return Math.round((v / total) * 100) + '% of cycle';
  }
  const rotationRows = [];
  const rotationCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Rotation timing']),
    ...PANELS.filter(p => enabledSet.has(p.k) || p.locked).map(p => {
      const settingKey = p.k === 'chores'     ? 'wall_chores_dwell_sec'
                       : p.k === 'weather'    ? 'wall_weather_dwell_sec'
                       : p.k === 'calendar'   ? 'wall_calendar_dwell_sec'
                       :                        'wall_verse_dwell_sec';
      const badge = el('span', { class: 'muted', style: { fontSize: '0.82rem', minWidth: '110px', textAlign: 'right' } }, [pctBadge(p.k)]);
      rotationRows.push({ panel: p.k, badge });
      return el('div', { class: 'row spaced', style: { marginBottom: '8px', alignItems: 'center' } }, [
        el('div', { style: { minWidth: '110px' } }, [p.label]),
        el('input', {
          type: 'number', min: '5', max: '600',
          value: String(dwellState[p.k]),
          style: { width: '90px' },
          onInput: (e) => {
            dwellState[p.k] = Number(e.target.value);
            for (const row of rotationRows) row.badge.textContent = pctBadge(row.panel);
          },
          onChange: async (e) => {
            const value = String(Number(e.target.value));
            try { await api.patch(`/api/admin/settings/${settingKey}`, { value }); e.target.style.borderColor = 'var(--green)'; setTimeout(() => { e.target.style.borderColor = ''; }, 800); }
            catch (err) { alert('Save failed: ' + err.message); }
          },
        }),
        el('span', { class: 'muted' }, ['sec']),
        badge,
      ]);
    }),
  ]);
  host.appendChild(rotationCard);

  // ------- Card 3: Weather -------
  const resolvedNote = el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
    (s.wall_weather_lat && s.wall_weather_lon)
      ? `Resolved to ${s.wall_weather_lat}, ${s.wall_weather_lon}`
      : 'Not resolved; weather panel will skip itself.',
  ]);
  const weatherCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Weather']),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Location (zip code, city, or lat,lon)']),
      el('input', {
        type: 'text', placeholder: '78634 or Hutto, TX',
        value: s.wall_weather_location || '',
        onChange: async (e) => {
          const value = e.target.value.trim();
          try {
            const r = await api.patch('/api/admin/settings/wall_weather_location', { value });
            resolvedNote.textContent = r.resolved
              ? `Resolved to ${r.resolved.lat}, ${r.resolved.lon}${r.resolved.name ? ' (' + r.resolved.name + ')' : ''}`
              : 'Could not resolve; weather panel will skip itself.';
            e.target.style.borderColor = 'var(--green)';
            setTimeout(() => { e.target.style.borderColor = ''; }, 800);
          } catch (err) { alert('Save failed: ' + err.message); }
        },
      }),
      resolvedNote,
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Unit']),
      el('select', {
        onChange: async (e) => {
          try { await api.patch('/api/admin/settings/wall_weather_unit', { value: e.target.value }); }
          catch (err) { alert('Save failed: ' + err.message); }
        },
      }, ['F','C'].map(u => el('option', { value: u, selected: (s.wall_weather_unit || 'F') === u }, [u]))),
    ]),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async () => {
        try {
          const r = await api.get('/api/wall/weather');
          alert(r.skip ? `Weather skipped: ${r.reason}` : `OK: ${r.current_temp}${r.unit === 'C' ? '°C' : '°F'}, theme ${r.theme}`);
        } catch (err) { alert('Test failed: ' + err.message); }
      },
    }, ['Test weather fetch']),
  ]);
  host.appendChild(weatherCard);

  // ------- Card 4: Sleep -------
  const timeField = (key, defaultVal, label) => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'time',
      value: s[key] || defaultVal,
      onChange: async (e) => {
        try { await api.patch(`/api/admin/settings/${key}`, { value: e.target.value }); e.target.style.borderColor = 'var(--green)'; setTimeout(() => { e.target.style.borderColor = ''; }, 800); }
        catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
  ]);
  const sleepCard = el('div', { class: 'card' }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Sleep']),
    timeField('wall_sleep_start', '22:00', 'Wall sleep start'),
    timeField('wall_sleep_end',   '06:00', 'Wall sleep end'),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Sleep clock style']),
      el('select', {
        onChange: async (e) => {
          try { await api.patch('/api/admin/settings/wall_sleep_clock_style', { value: e.target.value }); }
          catch (err) { alert('Save failed: ' + err.message); }
        },
      }, [
        ['digital','Digital'], ['analog-minimal','Analog · minimal'], ['analog-classic','Analog · classic'],
      ].map(([v, label]) => el('option', { value: v, selected: (s.wall_sleep_clock_style || 'analog-minimal') === v }, [label]))),
    ]),
  ]);
  host.appendChild(sleepCard);
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
  host.appendChild(timeField(
    'school_deadline_time', '16:00',
    'School-work deadline (24-hour local)',
    'After this time, any unsubmitted school-work chores forfeit their points for the day (they still count toward percent and streak as missed).',
  ));

  const retentionField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Photo retention (days)']),
    el('input', {
      type: 'number',
      min: '1',
      max: '30',
      value: s.photo_retention_days || '5',
      onChange: async (e) => {
        const v = e.target.value;
        try {
          await api.patch('/api/admin/settings/photo_retention_days', { value: String(v) });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'How long unreviewed photo submissions stay on disk before the daily sweep deletes them.',
    ]),
  ]);
  host.appendChild(retentionField);

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
    min_points: 5,
    max_points: 15,
    days_to_ripen: 5,
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
      el('label', {}, ['Min points (starting value when posted)']),
      el('input', { type: 'number', min: '1', value: form.min_points, onInput: e => form.min_points = Number(e.target.value) }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Max points (peak value before bonus expires)']),
      el('input', { type: 'number', min: '1', value: form.max_points, onInput: e => form.max_points = Number(e.target.value) }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Days to ripen (min to max)']),
      el('input', { type: 'number', min: '1', max: '30', value: form.days_to_ripen, onInput: e => form.days_to_ripen = Number(e.target.value) }),
      el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
        'Set min == max to disable ripening (bonus stays at that value).',
      ]),
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

  const hasRipen = b.min_points != null && b.max_points != null && b.max_points > b.min_points;
  const cur = b.current_points ?? b.points;
  const ripeLine = hasRipen
    ? `Ripening: ${cur} now · ${b.min_points} -> ${b.max_points} over ${b.days_to_ripen}d${b.ripens_full_on ? ' · expires after today' : ''}`
    : `Fixed at ${b.points}`;

  return el('div', { class: 'review-row' }, [
    el('div', { class: 'row spaced' }, [
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [b.title]),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `+${cur} pts · ${b.anti_cheat}${b.description ? ' · ' + b.description : ''}`,
        ]),
        el('div', { class: 'muted', style: { fontSize: '0.72rem', marginTop: '2px' } }, [ripeLine]),
      ]),
      el('span', { class: 'pill ' + statusClass }, [statusText]),
    ]),
    actions.length > 0 ? el('div', { class: 'row spaced approval-actions' }, actions) : null,
  ].filter(Boolean));
}
