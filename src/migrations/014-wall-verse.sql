-- src/migrations/014-wall-verse.sql
INSERT INTO settings (key, value) VALUES
  ('wall_verse_dwell_sec', '20')
ON CONFLICT(key) DO NOTHING;

-- Move the never-rendered calendar/verse-fact default to the built verse panel.
UPDATE settings
   SET value = 'chores,weather,verse'
 WHERE key = 'wall_enabled_panels'
   AND value = 'chores,weather,calendar,verse-fact';
