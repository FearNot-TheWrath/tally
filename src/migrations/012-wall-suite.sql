INSERT INTO settings (key, value) VALUES
  ('wall_enabled_panels',     'chores,weather,calendar,verse-fact'),
  ('wall_chores_dwell_sec',   '60'),
  ('wall_other_dwell_sec',    '15'),
  ('wall_weather_lat',        ''),
  ('wall_weather_lon',        ''),
  ('wall_weather_unit',       'F'),
  ('wall_sleep_start',        '22:00'),
  ('wall_sleep_end',          '06:00'),
  ('wall_sleep_clock_style',  'analog-minimal')
ON CONFLICT(key) DO NOTHING;
