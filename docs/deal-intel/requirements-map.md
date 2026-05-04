# Deal Intel PDFs → Implementation Map

This document maps requirements from `Cursor Input.pdf` and `Schema (1).pdf` to concrete implementation work in this repo (DB objects, background jobs, ingestion steps, and UI surface area).

## 1) Fast-first ingestion (2–5 seconds usable)

- **Requirement**: ingestion must return usable state in ~2–5 seconds; expensive work must be background or on-demand.
- **DB**: add a background queue (`deal_intel.bg_job`) and minimal status markers on `deal_intel.document` and `deal_intel.deal_tree_node` (internal use).
- **Jobs**:
  - `doc_refine_chunks` (semantic merging + embeddings)
  - `deal_refine_tree` (signal/anchor/root refinement)
  - `claims_extract` (LLM extraction + claim indexing)
  - `keywords_refresh` (keyword graph + offline cluster reconcile)
- **Ingestion**: fast endpoint should only:
  - parse pages (no heavy LLM)
  - produce initial semantic-ish chunks (bounded count)
  - embed only the first N high-signal chunks (batched)
  - write root + child narrative embeddings (no persona/sub-child embeddings)
  - enqueue all heavy refinement
- **UI**: upload immediately shows `Ready` (searchable), optionally a subtle “Improving…” badge; no job UI.

## 2) Deal knowledge graph (root/child/sub-child) computed in two phases

### Root node

- **Requirement**: root centroid approximate first, refined later.
- **DB**: reuse `deal_intel.deal_tree_node(kind='root')` and its `centroid_embedding` + `keywords`.
- **Hot path**:
  - compute root centroid from *top-level semantic chunks only* (document chunks, or child narratives if available)
  - store raw/global keywords (unclustered)
- **Async**:
  - refine root centroid (“super centroid”) from finalized child embeddings + weights

### Child nodes (Problem/Solution/Traction/People/Negatives/Delta placeholder)

- **Requirement**: hot path only narrative vector + raw keywords; no signal/anchor in hot path.
- **DB**: reuse `deal_tree_node(kind='child')`:
  - hot path writes `narrative_text`, `narrative_embedding`, raw `keywords`
  - async writes `signal_embedding`, `anchor_embedding`, weights
- **Async**:
  - compute signal vector from aggregated subcomponents
  - compute anchor vector from keyword centroid/clusters
  - optionally create `delta` placeholder node later

### Sub-child nodes (atomic components)

- **Requirement**: store structured fields + provenance immediately; embeddings lazy/high-salience only.
- **DB**:
  - structured facts: `deal_intel.deal_fact_node` (path/value/source_map)
  - optional semantic subchildren: `deal_tree_node(kind='sub_child')` only for high-salience items
- **Async**:
  - embed remaining sub-child nodes
  - generate persona nodes only async

## 3) Metadata payload (citations/traceability)

- **Requirement**: `source_map` includes doc id, file name, blob url, page number, char offsets/coords; used for citations only.
- **DB**:
  - `deal_intel.document_*` tables already store page/char spans
  - ensure `deal_fact_node.source_map` and `deal_tree_node.source_map` include citation pointers (`document_id`, `page_number`, `char_start`, `char_end`, optional coords)
- **Ingestion**:
  - preserve trace from document chunk/sentence → derived facts/claims
- **UI**:
  - citations link to PDF page and highlight span (later)

## 4) Hybrid similarity search (similar company search)

- **Requirement**:
  - candidate filter via BM25 (raw keywords) + vector search (root centroid)
  - RRF merge
  - secondary scoring uses available child embeddings if computed
  - optional deep analysis async/on-demand
- **DB**:
  - reuse `deal_intel.match_similar_deals_hybrid` but ensure it consults **root centroid** + **root search_document/keywords**
  - add “secondary scoring” RPC (optional) that re-ranks top K with child embeddings only when present
- **UI**:
  - show fast results; optionally “why this matched” (keyword overlap + centroid similarity)

## 5) Keyword system (eventually consistent)

- **Requirement**: hot path stores raw keywords; async builds online graph and periodically clusters (HDBSCAN/hierarchical), with fixed token budget.
- **DB**:
  - reuse existing keyword tables if present; add missing DSU/cluster snapshot tables if needed
- **Jobs**:
  - `keywords_build_graph_online`
  - `keywords_cluster_offline`
  - `keywords_reconcile_snapshot`

## 6) Documents: semantic chunking (pitch deck vs pdf doc) + fast embedding

- **Requirement**:
  - semantic chunks, not fixed token chunking
  - initial components 150–300 tokens, 10–20% overlap
  - merge adjacent components if semantically similar, split on topic shift
  - LLM only for classification/edge cases, not full-structure extraction
- **DB**:
  - add `deal_intel.document_component` (structure-first units)
  - keep `document_chunk` for produced semantic chunks (`fast` and `refined`)
- **Jobs**:
  - `doc_classify_type`
  - `doc_refine_components_and_chunks`
  - `doc_embed_remaining_chunks`

## 7) Upload routing: company-specific vs general documents

- **Requirement**: system decides which company the doc belongs to; if unknown ask; create folder/path automatically.
- **DB**:
  - reuse `deal_intel.document.deal_id` nullable for “general”
  - add minimal metadata for routing confidence and inferred company
- **Backend**:
  - cheap heuristics first, embedding match only if needed
- **UI**:
  - one upload surface; default auto-attach; one-shot override if low confidence

## 8) Research findings + preferences schemas (Layer 1c/1d)

- **Requirement**: store web findings like documents; learn website preferences and rules with confidence/recency.
- **DB**: add tables for rules, website preferences, investment preferences + embeddings.
- **UI**: research planner consumes preferences; feedback updates confidence over time.

