-- Global keyword medoid clusters (online registration) + nullable risk columns on retrieval index.

CREATE TABLE IF NOT EXISTS public.keyword_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vocab_version int NOT NULL DEFAULT 1,
  medoid_phrase text NOT NULL,
  medoid_embedding vector(768) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medoid_phrase)
);

CREATE INDEX IF NOT EXISTS keyword_clusters_medoid_embedding_hnsw_idx
  ON public.keyword_clusters
  USING hnsw (medoid_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ALTER TABLE public.deal_retrieval_index
  ALTER COLUMN risk_embedding DROP NOT NULL,
  ALTER COLUMN risk_normalized DROP NOT NULL;
