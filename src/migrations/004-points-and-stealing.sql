ALTER TABLE chores ADD COLUMN weight INTEGER NOT NULL DEFAULT 3
  CHECK (weight BETWEEN 1 AND 5);
ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0
  CHECK (is_school_work IN (0, 1));

ALTER TABLE assignments ADD COLUMN stolen_from INTEGER REFERENCES people(id);
CREATE INDEX idx_assignments_stolen_from ON assignments(stolen_from)
  WHERE stolen_from IS NOT NULL;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('steal_unlock_time', '16:00');
