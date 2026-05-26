import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const TABS = [
  { key: 'today',     label: 'Today',     render: renderToday },
  { key: 'approvals', label: 'Approvals', render: renderApprovals },
  { key: 'people',    label: 'People',    render: renderPeople },
  { key: 'chores',    label: 'Chores',    render: renderChores },
];

export async function renderAdmin(root) {
  clear(root);
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

  root.appendChild(el('div', { class: 'page wide stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, ['Tally · Admin']),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
      ]),
    ]),
    tabsBar,
    content,
  ]));

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
    d.kids.map(k => el('div', { class: 'list-row' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'av', style: { background: k.avatar_color } }, [k.name[0]]),
        el('div', {}, [
          el('div', { style: { fontWeight: 600 } }, [k.name]),
          el('div', { class: 'muted', style: { fontSize: '0.82rem' } }, [
            `${k.today_done}/${k.today_total} today` + (k.overdue ? ` · ${k.overdue} overdue` : ''),
          ]),
        ]),
      ]),
      el('span', { class: 'num pts' }, [`${k.today_total === 0 ? 100 : Math.round(k.today_done / k.today_total * 100)}%`]),
    ]))
  ));
}

/* ───── People tab ───── */
async function renderPeople(host) {
  clear(host);
  const { people } = await api.get('/api/admin/people');
  const rows = people.map(p => el('div', { class: 'list-row', onClick: () => editPerson(p, host) }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [p.name]),
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
          `${c.recurs} · ${c.anti_cheat} · ${c.points} pts`
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
    title: '', points: 5, kind: 'recurring', recurs: 'daily', anti_cheat: 'honor',
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
    a.photo_url ? el('a', { href: a.photo_url, target: '_blank' }, [
      el('img', { class: 'approval-photo', src: a.photo_url, alt: a.chore_title }),
    ]) : null,
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
