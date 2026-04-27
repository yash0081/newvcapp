-- Post-baseline cleanup of legacy / unused tables.
-- Keep user preference tables; only remove tables confirmed unused by current app paths.

-- Unused claims-conflict table (not referenced by current API/runtime paths).
DROP TABLE IF EXISTS deal_intel.company_fact_conflict CASCADE;

-- Unused meeting memory table (worker does not currently read/write this table).
DROP TABLE IF EXISTS deal_intel.meeting_memory CASCADE;
