CREATE TABLE IF NOT EXISTS assignment_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_assignment_photos_assignment ON assignment_photos(assignment_id);

INSERT INTO assignment_photos (assignment_id, path)
  SELECT id, photo_path FROM assignments WHERE photo_path IS NOT NULL AND photo_path != '';
UPDATE assignments SET photo_path = NULL WHERE photo_path IS NOT NULL;
