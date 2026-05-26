import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

export async function renderPicker(root) {
  clear(root);
  const { people } = await api.get('/api/auth/picker');

  const grid = el('div', { class: 'picker-grid' },
    people.map(p => el('button', {
      class: 'picker-tile',
      onClick: () => onPick(p, root),
    }, [
      el('div', { class: 'av lg', style: { background: p.avatar_color } }, [p.name[0].toUpperCase()]),
      el('div', { class: 'picker-name' }, [p.name]),
      el('div', { class: 'label' }, [p.role]),
    ]))
  );

  root.appendChild(el('div', { class: 'page' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, ['Tally']),
    ]),
    el('p', { class: 'muted', style: { marginBottom: '24px' } }, ['Who\'s using this device?']),
    grid,
  ]));
}

async function onPick(person, root) {
  if (person.role === 'parent') return promptForPin(person, root);
  try {
    await api.post('/api/auth/login', { person_id: person.id });
    window.tallyNavigate('/');
  } catch (e) {
    alert('Login failed: ' + e.message);
  }
}

function promptForPin(person, root) {
  const pin = prompt(`Parent PIN for ${person.name}:`);
  if (!pin) return;
  api.post('/api/auth/login', { person_id: person.id, pin })
    .then(() => window.tallyNavigate('/'))
    .catch(e => alert('Wrong PIN: ' + e.message));
}
