-- deal_intel: claims layer + canonical memory tables
-- Claims are sentence-grounded extractions; canonical memory reconciles claims into stable fact paths.

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

-- 1) Claims
CREATE TABLE IF NOT EXISTS deal_intel.claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deal_id uuid REFERENCES deal_intel.deal(id) ON DELETE SET NULL,
  document_id uuid NOT NULL REFERENCES deal_intel.document(id) ON DELETE CASCADE,
  page_number int CHECK (page_number >= 1),
  sentence_id uuid REFERENCES deal_intel.document_sentence(id) ON DELETE SET NULL,

  quote text NOT NULL,
  claim_type text NOT NULL,
  key text,

  value_text text,
  value_number numeric,
  value_jsonb jsonb,

  time_start date,
  time_end date,
  confidence numeric,

  embedding vector(768),
  embedding_model text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_claim_user_idx
  ON deal_intel.claim(user_id);
CREATE INDEX IF NOT EXISTS deal_intel_claim_deal_key_idx
  ON deal_intel.claim(deal_id, key);
CREATE INDEX IF NOT EXISTS deal_intel_claim_document_page_idx
  ON deal_intel.claim(document_id, page_number);
CREATE INDEX IF NOT EXISTS deal_intel_claim_embedding_hnsw_idx
  ON deal_intel.claim
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- 2) Canonical facts (company memory)
CREATE TABLE IF NOT EXISTS deal_intel.company_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  fact_path text NOT NULL,
  canonical_value_text text,
  canonical_value_jsonb jsonb,
  source_claim_id uuid REFERENCES deal_intel.claim(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','conflicted','needs_review')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, fact_path)
);

CREATE INDEX IF NOT EXISTS deal_intel_company_fact_deal_idx
  ON deal_intel.company_fact(deal_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_fact_conflict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  fact_path text NOT NULL,
  claim_a_id uuid NOT NULL REFERENCES deal_intel.claim(id) ON DELETE CASCADE,
  claim_b_id uuid NOT NULL REFERENCES deal_intel.claim(id) ON DELETE CASCADE,
  conflict_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_fact_conflict_deal_idx
  ON deal_intel.company_fact_conflict(deal_id);

-- RLS
ALTER TABLE deal_intel.claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_fact_conflict ENABLE ROW LEVEL SECURITY;

-- Claims: user owns claim
DROP POLICY IF EXISTS "deal_intel.claim select own" ON deal_intel.claim;
CREATE POLICY "deal_intel.claim select own"
  ON deal_intel.claim FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.claim insert own" ON deal_intel.claim;
CREATE POLICY "deal_intel.claim insert own"
  ON deal_intel.claim FOR INSERT
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.claim update own" ON deal_intel.claim;
CREATE POLICY "deal_intel.claim update own"
  ON deal_intel.claim FOR UPDATE
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.claim delete own" ON deal_intel.claim;
CREATE POLICY "deal_intel.claim delete own"
  ON deal_intel.claim FOR DELETE
  USING (user_id = auth.uid());

-- company_fact: authorize via deal ownership
DROP POLICY IF EXISTS "deal_intel.company_fact select own" ON deal_intel.company_fact;
CREATE POLICY "deal_intel.company_fact select own"
  ON deal_intel.company_fact FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact.deal_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.company_fact insert own" ON deal_intel.company_fact;
CREATE POLICY "deal_intel.company_fact insert own"
  ON deal_intel.company_fact FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact.deal_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.company_fact update own" ON deal_intel.company_fact;
CREATE POLICY "deal_intel.company_fact update own"
  ON deal_intel.company_fact FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact.deal_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.company_fact delete own" ON deal_intel.company_fact;
CREATE POLICY "deal_intel.company_fact delete own"
  ON deal_intel.company_fact FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact.deal_id AND d.user_id = auth.uid()
  ));

-- conflicts: authorize via deal ownership
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict select own" ON deal_intel.company_fact_conflict;
CREATE POLICY "deal_intel.company_fact_conflict select own"
  ON deal_intel.company_fact_conflict FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact_conflict.deal_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict insert own" ON deal_intel.company_fact_conflict;
CREATE POLICY "deal_intel.company_fact_conflict insert own"
  ON deal_intel.company_fact_conflict FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact_conflict.deal_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.company_fact_conflict delete own" ON deal_intel.company_fact_conflict;
CREATE POLICY "deal_intel.company_fact_conflict delete own"
  ON deal_intel.company_fact_conflict FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.deal d
    WHERE d.id = company_fact_conflict.deal_id AND d.user_id = auth.uid()
  ));

