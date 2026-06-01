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

const TEXT_BY_CODE = new Map([
  [0, 'Clear'], [1, 'Clear'], [2, 'Partly cloudy'], [3, 'Overcast'],
  [45, 'Fog'], [48, 'Fog'],
  [51, 'Drizzle'], [53, 'Drizzle'], [55, 'Drizzle'], [56, 'Freezing drizzle'], [57, 'Freezing drizzle'],
  [61, 'Rain'], [63, 'Rain'], [65, 'Heavy rain'], [66, 'Freezing rain'], [67, 'Freezing rain'],
  [71, 'Snow'], [73, 'Snow'], [75, 'Heavy snow'], [77, 'Snow grains'],
  [80, 'Rain showers'], [81, 'Rain showers'], [82, 'Heavy showers'],
  [85, 'Snow showers'], [86, 'Snow showers'],
  [95, 'Thunderstorms'], [96, 'Thunderstorms'], [99, 'Thunderstorms'],
]);

export function wmoToText(code, isDay) {
  if ((code === 0 || code === 1) && isDay) return 'Sunny';
  return TEXT_BY_CODE.get(code) || 'Cloudy';
}

export function parseForecast(json, opts = {}) {
  const cur = json.current || {};
  const d = json.daily || {};
  const h = json.hourly || {};
  const curTemp = Math.round(cur.temperature_2m ?? 0);
  const isDay = !!cur.is_day;

  const todayHigh = Math.round(d.temperature_2m_max?.[0] ?? 0);
  const todayLow  = Math.round(d.temperature_2m_min?.[0] ?? 0);

  const forecast = [];
  for (let i = 1; i <= 3 && i < (d.time?.length || 0); i++) {
    const code = d.weather_code?.[i] ?? -1;
    forecast.push({
      day_iso:   d.time[i],
      theme:     mapWmoToTheme(code, true),
      code,
      condition: wmoToText(code, true),
      high:      Math.round(d.temperature_2m_max?.[i] ?? 0),
      low:       Math.round(d.temperature_2m_min?.[i] ?? 0),
      precip:    Math.round(d.precipitation_probability_max?.[i] ?? 0),
    });
  }

  const hourly = [];
  const times = h.time || [];
  let start = opts.nowHourIndex;
  if (start == null) {
    const nowIso = (new Date()).toISOString().slice(0, 13);
    start = times.findIndex(t => String(t).slice(0, 13) >= nowIso);
    if (start < 0) start = 0;
  }
  for (let i = start; i < start + 12 && i < times.length; i++) {
    hourly.push({
      time:        times[i],
      temp:        Math.round(h.temperature_2m?.[i] ?? 0),
      code:        h.weather_code?.[i] ?? -1,
      is_day:      !!h.is_day?.[i],
      precip_prob: Math.round(h.precipitation_probability?.[i] ?? 0),
    });
  }

  return {
    current_temp: curTemp,
    apparent_temp: Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 0),
    humidity:     Math.round(cur.relative_humidity_2m ?? 0),
    wind:         Math.round(cur.wind_speed_10m ?? 0),
    condition:    wmoToText(cur.weather_code ?? -1, isDay),
    theme:        mapWmoToTheme(cur.weather_code ?? -1, isDay),
    is_day:       isDay,
    today_high:   todayHigh,
    today_low:    todayLow,
    today_precip: Math.round(d.precipitation_probability_max?.[0] ?? 0),
    sunrise:      d.sunrise?.[0] ?? null,
    sunset:       d.sunset?.[0] ?? null,
    hourly,
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
  url.searchParams.set('current',  'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day');
  url.searchParams.set('hourly',   'temperature_2m,weather_code,is_day,precipitation_probability');
  url.searchParams.set('daily',    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  url.searchParams.set('wind_speed_unit', unit === 'C' ? 'kmh' : 'mph');
  url.searchParams.set('forecast_days', '4');
  url.searchParams.set('temperature_unit', tempUnit);
  url.searchParams.set('timezone',  'auto');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return await r.json();
}
