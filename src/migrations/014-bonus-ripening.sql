ALTER TABLE chores ADD COLUMN min_points     INTEGER;
ALTER TABLE chores ADD COLUMN max_points     INTEGER;
ALTER TABLE chores ADD COLUMN days_to_ripen  INTEGER NOT NULL DEFAULT 5
  CHECK (days_to_ripen >= 1 AND days_to_ripen <= 30);
ALTER TABLE chores ADD COLUMN current_points INTEGER;
ALTER TABLE chores ADD COLUMN ripens_from    TEXT;
ALTER TABLE chores ADD COLUMN ripens_full_on TEXT;

-- Backwards compat: existing bonuses get min=max=current=points and ripens_from=today,
-- which means step=0 so they never actually ripen until the parent edits them.
UPDATE chores
SET min_points     = points,
    max_points     = points,
    current_points = points,
    ripens_from    = date('now', 'localtime')
WHERE kind = 'bonus' AND min_points IS NULL;
