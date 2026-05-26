INSERT INTO settings (key, value) VALUES
  ('admin_pin_hash', 'de262d129301e5b3cc699a88b3892212:43e0f8839e3be962337be999d67a7600ce8ab06638d8b595afcd28cbf0513725f32757542e6f3395cf746ed288f7338b722f1d288b1be0890a34816b73c9f904'),
  ('late_tax_pct_default', '50'),
  ('reminder_time', '16:00'),
  ('payout_day', '0'),
  ('payout_time', '19:00'),
  ('photo_retention_days', '90'),
  ('wall_theme', 'system');

-- A default "wall" identity for the wall display (no auth, but exists for joins).
INSERT INTO people (name, role, avatar_color) VALUES ('Wall', 'wall', '#0F172A');
