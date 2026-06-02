INSERT INTO settings (key, value) VALUES
  ('wall_weather_radar', 'on')
ON CONFLICT(key) DO NOTHING;
