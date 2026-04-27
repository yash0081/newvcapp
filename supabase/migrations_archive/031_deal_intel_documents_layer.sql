-- deal_intel: documents grounding layer (documents/pages/chunks/sentences)
-- Stores uploaded PDFs (via Supabase Storage) and their extracted text for citations + retrieval.

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

-- 1) Documents (ground truth container)
CREATE TABLE IF NOT EXISTS deal_intel.document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deal_id uuid REFERENCES deal_intel.deal(id) ON DELETE SET NULL,
  source_kind text NOT NULL DEFAULT 'pitch_deck',

  original_filename text,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  byte_size int,
  sha256 text,

  storage_provider text NOT NULL DEFAULT 'supabase_storage',
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  folder_path text,

  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsed','chunked','claims_extracted','ready','error')),
  error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_document_updated_at ON deal_intel.document;
CREATE TRIGGER deal_intel_document_updated_at
BEFORE UPDATE ON deal_intel.document
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_document_user_created_idx
  ON deal_intel.document(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deal_intel_document_deal_idx
  ON deal_intel.document(deal_id);
CREATE UNIQUE INDEX IF NOT EXISTS deal_intel_document_user_sha256_uniq
  ON deal_intel.document(user_id, sha256)
  WHERE sha256 IS NOT NULL;

-- 2) Per-page extracted text
CREATE TABLE IF NOT EXISTS deal_intel.document_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES deal_intel.document(id) ON DELETE CASCADE,
  page_number int NOT NULL CHECK (page_number >= 1),
  text text NOT NULL,
  char_count int NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_number)
);

CREATE INDEX IF NOT EXISTS deal_intel_document_page_document_idx
  ON deal_intel.document_page(document_id);

-- 3) Precomputed sentences (citation backbone)
CREATE TABLE IF NOT EXISTS deal_intel.document_sentence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES deal_intel.document(id) ON DELETE CASCADE,
  page_number int NOT NULL CHECK (page_number >= 1),
  sentence_index int NOT NULL CHECK (sentence_index >= 0),
  text text NOT NULL,
  char_start int NOT NULL CHECK (char_start >= 0),
  char_end int NOT NULL CHECK (char_end >= 0),
  embedding vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_number, sentence_index)
);

CREATE INDEX IF NOT EXISTS deal_intel_document_sentence_document_idx
  ON deal_intel.document_sentence(document_id);
CREATE INDEX IF NOT EXISTS deal_intel_document_sentence_document_page_idx
  ON deal_intel.document_sentence(document_id, page_number);
CREATE INDEX IF NOT EXISTS deal_intel_document_sentence_embedding_hnsw_idx
  ON deal_intel.document_sentence
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- 4) Retrieval chunks
CREATE TABLE IF NOT EXISTS deal_intel.document_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES deal_intel.document(id) ON DELETE CASCADE,
  page_start int NOT NULL CHECK (page_start >= 1),
  page_end int NOT NULL CHECK (page_end >= 1),
  char_start int NOT NULL CHECK (char_start >= 0),
  char_end int NOT NULL CHECK (char_end >= 0),
  text text NOT NULL,
  embedding vector(768),
  embedding_model text,
  keywords text[] NOT NULL DEFAULT '{}'::text[],
  search_document tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION deal_intel.set_document_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document := to_tsvector('english', coalesce(NEW.text, '') || ' ' || coalesce(array_to_string(NEW.keywords, ' '), ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_intel_document_chunk_fts ON deal_intel.document_chunk;
CREATE TRIGGER deal_intel_document_chunk_fts
BEFORE INSERT OR UPDATE OF text, keywords
ON deal_intel.document_chunk
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_document_chunk_search_document();

CREATE INDEX IF NOT EXISTS deal_intel_document_chunk_document_idx
  ON deal_intel.document_chunk(document_id);
CREATE INDEX IF NOT EXISTS deal_intel_document_chunk_search_gin_idx
  ON deal_intel.document_chunk USING gin (search_document);
CREATE INDEX IF NOT EXISTS deal_intel_document_chunk_embedding_hnsw_idx
  ON deal_intel.document_chunk
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- RLS
ALTER TABLE deal_intel.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.document_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.document_sentence ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.document_chunk ENABLE ROW LEVEL SECURITY;

-- Documents
DROP POLICY IF EXISTS "deal_intel.document select own" ON deal_intel.document;
CREATE POLICY "deal_intel.document select own"
  ON deal_intel.document FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.document insert own" ON deal_intel.document;
CREATE POLICY "deal_intel.document insert own"
  ON deal_intel.document FOR INSERT
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.document update own" ON deal_intel.document;
CREATE POLICY "deal_intel.document update own"
  ON deal_intel.document FOR UPDATE
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.document delete own" ON deal_intel.document;
CREATE POLICY "deal_intel.document delete own"
  ON deal_intel.document FOR DELETE
  USING (user_id = auth.uid());

-- Pages/sentences/chunks authorize via document ownership
DROP POLICY IF EXISTS "deal_intel.document_page select own" ON deal_intel.document_page;
CREATE POLICY "deal_intel.document_page select own"
  ON deal_intel.document_page FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_page.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_page insert own" ON deal_intel.document_page;
CREATE POLICY "deal_intel.document_page insert own"
  ON deal_intel.document_page FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_page.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_page update own" ON deal_intel.document_page;
CREATE POLICY "deal_intel.document_page update own"
  ON deal_intel.document_page FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_page.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_page delete own" ON deal_intel.document_page;
CREATE POLICY "deal_intel.document_page delete own"
  ON deal_intel.document_page FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_page.document_id AND d.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "deal_intel.document_sentence select own" ON deal_intel.document_sentence;
CREATE POLICY "deal_intel.document_sentence select own"
  ON deal_intel.document_sentence FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_sentence.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_sentence insert own" ON deal_intel.document_sentence;
CREATE POLICY "deal_intel.document_sentence insert own"
  ON deal_intel.document_sentence FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_sentence.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_sentence update own" ON deal_intel.document_sentence;
CREATE POLICY "deal_intel.document_sentence update own"
  ON deal_intel.document_sentence FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_sentence.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_sentence delete own" ON deal_intel.document_sentence;
CREATE POLICY "deal_intel.document_sentence delete own"
  ON deal_intel.document_sentence FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_sentence.document_id AND d.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "deal_intel.document_chunk select own" ON deal_intel.document_chunk;
CREATE POLICY "deal_intel.document_chunk select own"
  ON deal_intel.document_chunk FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_chunk.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_chunk insert own" ON deal_intel.document_chunk;
CREATE POLICY "deal_intel.document_chunk insert own"
  ON deal_intel.document_chunk FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_chunk.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_chunk update own" ON deal_intel.document_chunk;
CREATE POLICY "deal_intel.document_chunk update own"
  ON deal_intel.document_chunk FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_chunk.document_id AND d.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS "deal_intel.document_chunk delete own" ON deal_intel.document_chunk;
CREATE POLICY "deal_intel.document_chunk delete own"
  ON deal_intel.document_chunk FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM deal_intel.document d
    WHERE d.id = document_chunk.document_id AND d.user_id = auth.uid()
  ));

