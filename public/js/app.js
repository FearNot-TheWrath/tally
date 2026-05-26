import { api } from './lib/api.js';
import { $, clear } from './lib/dom.js';
import { renderPicker } from './pages/picker.js';
import { renderHome } from './pages/home.js';
import { renderAdmin } from './pages/admin.js';

const app = $('#app');

const routes = [
  { path: /^\/$/, render: routeRoot },
  { path: /^\/admin/, render: () => renderAdmin(app) },
];

async function routeRoot() {
  try {
    const me = await api.get('/api/me');
    if (me.role === 'kid') return renderHome(app);
    if (me.role === 'parent') return renderAdmin(app);
  } catch (e) {
    if (e.status === 401) return renderPicker(app);
    throw e;
  }
}

async function navigate(path = location.pathname) {
  for (const r of routes) {
    if (r.path.test(path)) { clear(app); await r.render(); return; }
  }
  clear(app);
  app.appendChild(document.createTextNode('Not found'));
}

window.addEventListener('popstate', () => navigate());
window.tallyNavigate = (path) => { history.pushState({}, '', path); navigate(); };

navigate();
