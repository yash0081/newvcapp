-- deal_intel: retrieval RPCs for document chunks + claims (vector + FTS)

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Add FTS support for claims
ALTER TABLE IF EXISTS deal_intel.claim
  ADD COLUMN IF NOT EXISTS search_document tsvector;

CREATE OR REPLACE FUNCTION deal_intel.set_claim_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document := to_tsvector('english', coalesce(NEW.quote, '') || ' ' || coalesce(NEW.key, '') || ' ' || coalesce(NEW.claim_type, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_intel_claim_fts ON deal_intel.claim;
CREATE TRIGGER deal_intel_claim_fts
BEFORE INSERT OR UPDATE OF quote, key, claim_type
ON deal_intel.claim
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_claim_search_document();

CREATE INDEX IF NOT EXISTS deal_intel_claim_search_gin_idx
  ON deal_intel.claim USING gin (search_document);

-- RPC: match document chunks by FTS (scoped to user, optional deal)
CREATE OR REPLACE FUNCTION public.deal_intel_match_document_chunks_fts(
  p_user_id uuid,
  p_query text,
  p_match_count int DEFAULT 20,
  p_deal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  page_start int,
  page_end int,
  text text,
  score double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_start,
    c.page_end,
    c.text,
    ts_rank_cd(c.search_document, plainto_tsquery('english', p_query)) AS score
  FROM deal_intel.document_chunk c
  JOIN deal_intel.document d ON d.id = c.document_id
  WHERE d.user_id = p_user_id
    AND (p_deal_id IS NULL OR d.deal_id = p_deal_id)
    AND c.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY score DESC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_match_document_chunks_vector(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_match_count int DEFAULT 20,
  p_deal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  page_start int,
  page_end int,
  text text,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_start,
    c.page_end,
    c.text,
    1 - (c.embedding <=> p_query_embedding) AS similarity
  FROM deal_intel.document_chunk c
  JOIN deal_intel.document d ON d.id = c.document_id
  WHERE d.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND (p_deal_id IS NULL OR d.deal_id = p_deal_id)
  ORDER BY c.embedding <=> p_query_embedding ASC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;

-- Claims
CREATE OR REPLACE FUNCTION public.deal_intel_match_claims_fts(
  p_user_id uuid,
  p_query text,
  p_match_count int DEFAULT 20,
  p_deal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  page_number int,
  sentence_id uuid,
  quote text,
  claim_type text,
  key text,
  score double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_number,
    c.sentence_id,
    c.quote,
    c.claim_type,
    c.key,
    ts_rank_cd(c.search_document, plainto_tsquery('english', p_query)) AS score
  FROM deal_intel.claim c
  WHERE c.user_id = p_user_id
    AND (p_deal_id IS NULL OR c.deal_id = p_deal_id)
    AND c.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY score DESC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_match_claims_vector(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_match_count int DEFAULT 20,
  p_deal_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  page_number int,
  sentence_id uuid,
  quote text,
  claim_type text,
  key text,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_number,
    c.sentence_id,
    c.quote,
    c.claim_type,
    c.key,
    1 - (c.embedding <=> p_query_embedding) AS similarity
  FROM deal_intel.claim c
  WHERE c.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND (p_deal_id IS NULL OR c.deal_id = p_deal_id)
  ORDER BY c.embedding <=> p_query_embedding ASC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;

GRANT EXECUTE ON FUNCTION public.deal_intel_match_document_chunks_fts(uuid, text, int, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_match_document_chunks_vector(uuid, vector(768), int, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_match_claims_fts(uuid, text, int, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_match_claims_vector(uuid, vector(768), int, uuid) TO authenticated, service_role;

