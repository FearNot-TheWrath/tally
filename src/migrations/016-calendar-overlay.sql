INSERT INTO settings (key, value) VALUES
  ('wall_calendar_oauth_refresh',  ''),
  ('wall_calendar_selected_ids',   ''),
  ('wall_calendar_list_cache',     '[]')
ON CONFLICT(key) DO NOTHING;
