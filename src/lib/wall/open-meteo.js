// Open-Meteo client. No API key. Caches handled by the caller (the route).
//
// WMO weather codes:
//   0       clear sky
//   1, 2, 3 mainly clear / partly cloudy / overcast
//   45, 48  fog
//   51-67   drizzle / rain (incl. freezing variants)
//   71-77   snow
//   80-82   rain showers
//   85, 86  snow showers
//   95-99   thunderstorm

const THEME_BY_CODE = new Map([
  [0, 'clear'],
  [1, 'clear'],
  [2, 'partly-cloudy'],
  [3, 'overcast'],
  [45, 'fog'], [48, 'fog'],
  [51, 'rain'], [53, 'rain'], [55, 'rain'],
  [56, 'rain'], [57, 'rain'],
  [61, 'rain'], [63, 'rain'], [65, 'rain'],
  [66, 'rain'], [67, 'rain'],
  [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'],
  [80, 'rain'], [81, 'rain'], [82, 'rain'],
  [85, 'snow'], [86, 'snow'],
  [95, 'thunderstorm'], [96, 'thunderstorm'], [99, 'thunderstorm'],
]);

export function mapWmoToTheme(code, isDay) {
  const t = THEME_BY_CODE.get(code) || 'overcast';
  if (t === 'clear') return isDay ? 'clear-day' : 'clear-night';
  return t;
}

export function parseForecast(json) {
  const cur = json.current || {};
  const d = json.daily || {};
  const todayHigh = Math.round(d.temperature_2m_max?.[0] ?? 0);
  const todayLow  = Math.round(d.temperature_2m_min?.[0] ?? 0);
  const forecast = [];
  for (let i = 1; i <= 3 && i < (d.time?.length || 0); i++) {
    forecast.push({
      day_iso: d.time[i],
      theme:   mapWmoToTheme(d.weather_code?.[i] ?? -1, true),
      high:    Math.round(d.temperature_2m_max?.[i] ?? 0),
      low:     Math.round(d.temperature_2m_min?.[i] ?? 0),
    });
  }
  return {
    current_temp: Math.round(cur.temperature_2m ?? 0),
    theme:        mapWmoToTheme(cur.weather_code ?? -1, !!cur.is_day),
    today_high:   todayHigh,
    today_low:    todayLow,
    forecast,
  };
}

// Live fetch. Caller is responsible for caching.
// unit: 'F' | 'C'
export async function fetchOpenMeteo(lat, lon, unit = 'F') {
  const tempUnit = unit === 'C' ? 'celsius' : 'fahrenheit';
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude',  String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current',   'temperature_2m,weather_code,is_day');
  url.searchParams.set('daily',     'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset');
  url.searchParams.set('temperature_unit', tempUnit);
  url.searchParams.set('timezone',  'auto');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return await r.json();
}
