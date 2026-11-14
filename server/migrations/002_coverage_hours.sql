-- Optional daily coverage window (whole hours, 0-23). Both null = around the
-- clock. end <= start means the window runs past midnight.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS coverage_start integer;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS coverage_end integer;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS coverage_updated_at text;
