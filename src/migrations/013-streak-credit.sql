ALTER TABLE people ADD COLUMN streak_credit INTEGER NOT NULL DEFAULT 0
  CHECK (streak_credit >= 0);
