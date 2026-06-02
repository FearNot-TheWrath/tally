import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWmoToTheme, parseForecast, wmoToText } from '../src/lib/wall/open-meteo.js';

test('mapWmoToTheme handles clear day and night', () => {
  assert.equal(mapWmoToTheme(0, true),  'clear-day');
  assert.equal(mapWmoToTheme(0, false), 'clear-night');
  assert.equal(mapWmoToTheme(1, true),  'clear-day');
});

test('mapWmoToTheme handles partly-cloudy', () => {
  assert.equal(mapWmoToTheme(2, true),  'partly-cloudy');
  assert.equal(mapWmoToTheme(3, true),  'overcast');
});

test('mapWmoToTheme handles fog', () => {
  assert.equal(mapWmoToTheme(45, true), 'fog');
  assert.equal(mapWmoToTheme(48, false), 'fog');
});

test('mapWmoToTheme handles drizzle and rain', () => {
  assert.equal(mapWmoToTheme(51, true), 'rain');
  assert.equal(mapWmoToTheme(61, true), 'rain');
  assert.equal(mapWmoToTheme(80, true), 'rain');
});

test('mapWmoToTheme handles snow', () => {
  assert.equal(mapWmoToTheme(71, true), 'snow');
  assert.equal(mapWmoToTheme(77, true), 'snow');
  assert.equal(mapWmoToTheme(85, true), 'snow');
});

test('mapWmoToTheme handles thunderstorm', () => {
  assert.equal(mapWmoToTheme(95, true), 'thunderstorm');
  assert.equal(mapWmoToTheme(99, true), 'thunderstorm');
});

test('mapWmoToTheme falls back to overcast on unknown codes', () => {
  assert.equal(mapWmoToTheme(123, true), 'overcast');
});

test('parseForecast extracts current + today + 3-day forecast', () => {
  const apiResponse = {
    current: { temperature_2m: 72.4, weather_code: 2, is_day: 1 },
    daily: {
      time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
      weather_code: [2, 61, 0, 71],
      temperature_2m_max: [85.1, 78.0, 90.0, 30.5],
      temperature_2m_min: [62.0, 60.5, 70.0, 20.1],
      sunrise: ['2026-06-01T06:15','2026-06-02T06:14','2026-06-03T06:14','2026-06-04T06:13'],
      sunset:  ['2026-06-01T20:30','2026-06-02T20:31','2026-06-03T20:32','2026-06-04T20:33'],
    },
  };
  const f = parseForecast(apiResponse);
  assert.equal(f.current_temp, 72);
  assert.equal(f.theme, 'partly-cloudy');
  assert.equal(f.today_high, 85);
  assert.equal(f.today_low,  62);
  assert.equal(f.forecast.length, 3);
  assert.equal(f.forecast[0].day_iso, '2026-06-02');
  assert.equal(f.forecast[0].theme, 'rain');
  assert.equal(f.forecast[0].high, 78);
  assert.equal(f.forecast[1].theme, 'clear-day');
  assert.equal(f.forecast[2].theme, 'snow');
});

test('wmoToText is day/night aware for clear sky', () => {
  assert.equal(wmoToText(0, true),  'Sunny');
  assert.equal(wmoToText(0, false), 'Clear');
  assert.equal(wmoToText(2, true),  'Partly cloudy');
  assert.equal(wmoToText(3, true),  'Overcast');
  assert.equal(wmoToText(61, true), 'Rain');
  assert.equal(wmoToText(95, true), 'Thunderstorms');
  assert.equal(wmoToText(999, true), 'Cloudy'); // fallback
});

test('parseForecast extracts current extras, hourly slice, and precip', () => {
  const api = {
    current: {
      temperature_2m: 91.4, apparent_temperature: 97.2, relative_humidity_2m: 53,
      wind_speed_10m: 5.3, weather_code: 0, is_day: 1,
    },
    hourly: {
      time: Array.from({ length: 30 }, (_, i) => `2026-06-01T${String(i).padStart(2,'0')}:00`),
      temperature_2m: Array.from({ length: 30 }, (_, i) => 70 + i),
      weather_code: Array.from({ length: 30 }, () => 0),
      is_day: Array.from({ length: 30 }, (_, i) => (i >= 7 && i <= 20 ? 1 : 0)),
      precipitation_probability: Array.from({ length: 30 }, () => 10),
    },
    daily: {
      time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
      weather_code: [0, 2, 3, 95],
      temperature_2m_max: [92, 92, 89, 88],
      temperature_2m_min: [73, 73, 70, 72],
      precipitation_probability_max: [0, 24, 24, 55],
      sunrise: ['2026-06-01T06:28','2026-06-02T06:28','2026-06-03T06:28','2026-06-04T06:28'],
      sunset:  ['2026-06-01T20:27','2026-06-02T20:27','2026-06-03T20:27','2026-06-04T20:27'],
    },
  };
  const f = parseForecast(api, { nowHourIndex: 18 });
  assert.equal(f.current_temp, 91);
  assert.equal(f.apparent_temp, 97);
  assert.equal(f.humidity, 53);
  assert.equal(f.wind, 5);
  assert.equal(f.condition, 'Sunny');
  assert.equal(f.today_precip, 0);
  assert.equal(f.sunrise, '2026-06-01T06:28');
  assert.equal(f.sunset, '2026-06-01T20:27');
  assert.equal(f.hourly.length, 12);
  assert.equal(f.hourly[0].temp, 88);
  assert.equal(f.hourly[0].precip_prob, 10);
  assert.equal(f.forecast[0].precip, 24);
  assert.equal(f.forecast[0].condition, 'Partly cloudy');
});

test('parseForecast tolerates missing hourly and short daily', () => {
  const f = parseForecast({ current: { temperature_2m: 80, weather_code: 0, is_day: 1 }, daily: {} });
  assert.equal(f.current_temp, 80);
  assert.deepEqual(f.hourly, []);
  assert.deepEqual(f.forecast, []);
  assert.equal(f.apparent_temp, 80);
});
