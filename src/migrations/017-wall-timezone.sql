INSERT INTO settings (key, value) VALUES
  ('wall_timezone', 'America/Chicago')
ON CONFLICT(key) DO NOTHING;
