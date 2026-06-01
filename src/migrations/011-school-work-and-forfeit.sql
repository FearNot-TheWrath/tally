ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0
  CHECK (is_school_work IN (0, 1));

ALTER TABLE assignments ADD COLUMN forfeited INTEGER NOT NULL DEFAULT 0
  CHECK (forfeited IN (0, 1));

CREATE INDEX idx_assignments_forfeited ON assignments(forfeited) WHERE forfeited = 1;
