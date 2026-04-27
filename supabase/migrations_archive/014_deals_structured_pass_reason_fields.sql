-- Structured fields extracted from deals.pass_reason_detail for retrieval pre-filtering.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS pass_reason_enum text;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS key_risks text[];

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS moat_type text;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS replication_difficulty text;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS product_type text;

