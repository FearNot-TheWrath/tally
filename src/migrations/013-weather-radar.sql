INSERT INTO settings (key, value) VALUES
  ('wall_weather_radar', 'on'),
  ('wall_radar_station', 'KEWX')
ON CONFLICT(key) DO NOTHING;
