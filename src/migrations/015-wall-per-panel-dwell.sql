INSERT INTO settings (key, value) VALUES
  ('wall_smart_cycle',        'on'),
  ('wall_weather_dwell_sec',  COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_calendar_dwell_sec', COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_verse_dwell_sec',    COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_weather_location',   '')
ON CONFLICT(key) DO NOTHING;
