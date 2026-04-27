-- Ensure pgvector exists before migrations that reference `vector` type.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Keep extensions schema resolvable for unqualified vector references.
SET search_path = public, extensions;
