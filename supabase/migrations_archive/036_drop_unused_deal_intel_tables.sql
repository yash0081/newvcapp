-- Aggressive cleanup: remove unused tables from deal_intel.
-- NOTE: This migration is destructive. If rollback is needed, restore from backup and re-run
-- the originating migrations (025/032/034) to recreate these objects.

-- 1) company_fact_conflict (introduced in 032, currently unused)
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict select own" ON deal_intel.company_fact_conflict;
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict insert own" ON deal_intel.company_fact_conflict;
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict delete own" ON deal_intel.company_fact_conflict;
DROP INDEX IF EXISTS deal_intel_company_fact_conflict_deal_idx;
DROP TABLE IF EXISTS deal_intel.company_fact_conflict;

-- 2) meeting_memory (introduced in 034, currently unused)
DROP POLICY IF EXISTS "deal_intel.meeting_memory read" ON deal_intel.meeting_memory;
DROP POLICY IF EXISTS "deal_intel.meeting_memory write" ON deal_intel.meeting_memory;
DROP TABLE IF EXISTS deal_intel.meeting_memory;

-- 3) user preference tables (introduced in 025, currently unused)
DROP POLICY IF EXISTS "deal_intel.user_website_preference_embedding select own" ON deal_intel.user_website_preference_embedding;
DROP POLICY IF EXISTS "deal_intel.user_website_preference_embedding upsert own" ON deal_intel.user_website_preference_embedding;
DROP TRIGGER IF EXISTS deal_intel_user_website_preference_embedding_updated_at ON deal_intel.user_website_preference_embedding;
DROP TABLE IF EXISTS deal_intel.user_website_preference_embedding;

DROP POLICY IF EXISTS "deal_intel.user_website_preference select own" ON deal_intel.user_website_preference;
DROP POLICY IF EXISTS "deal_intel.user_website_preference upsert own" ON deal_intel.user_website_preference;
DROP INDEX IF EXISTS deal_intel_user_website_preference_user_idx;
DROP TRIGGER IF EXISTS deal_intel_user_website_preference_updated_at ON deal_intel.user_website_preference;
DROP TABLE IF EXISTS deal_intel.user_website_preference;

DROP POLICY IF EXISTS "deal_intel.user_agent_preference select own" ON deal_intel.user_agent_preference;
DROP POLICY IF EXISTS "deal_intel.user_agent_preference upsert own" ON deal_intel.user_agent_preference;
DROP TRIGGER IF EXISTS deal_intel_user_agent_preference_updated_at ON deal_intel.user_agent_preference;
DROP TABLE IF EXISTS deal_intel.user_agent_preference;
