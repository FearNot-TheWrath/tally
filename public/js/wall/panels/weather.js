import { api } from '../../lib/api.js';

const ICON = {
  'clear-day': '☀',
  'clear-night': '☾',
  'partly-cloudy': '⛅',
  'overcast': '☁',
  'fog': '🌫',
  'rain': '🌧',
  'snow': '❄',
  'thunderstorm': '⛈',
};

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return DAYS[d.getDay()];
}

export default {
  key: 'weather',
  async fetch() {
    const r = await api.get('/api/wall/weather').catch(() => null);
    if (!r) return { skip: true, reason: 'weather fetch error' };
    if (r.skip) return { skip: true, reason: r.reason };
    return { data: r };
  },
  mount(host, d) {
    host.classList.add('wall-panel-weather');
    // Reset theme classes, then apply this one.
    host.classList.forEach(c => { if (c.startsWith('weather-theme-')) host.classList.remove(c); });
    host.classList.add(`weather-theme-${d.theme}`);
    const u = d.unit === 'C' ? '°C' : '°F';
    host.innerHTML = `
      <div class="weather-current">
        <div class="temp">${d.current_temp}${u}</div>
        <div class="hilo">H ${d.today_high}${u} · L ${d.today_low}${u}</div>
        <div class="weather-forecast">
          ${d.forecast.map(f => `
            <div class="day">
              <div class="label">${dayLabel(f.day_iso)}</div>
              <div class="ico">${ICON[f.theme] || ICON.overcast}</div>
              <div class="hilo">${f.high}° / ${f.low}°</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },
  unmount() {
    // No timers.
  },
};
