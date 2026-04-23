# deal_intel PDF Gap Audit

This file records the PDF-parity gap analysis and the implementation choices used to close those gaps.

## Closed Gaps

- Fact graph hierarchy now persists parent chains and explicit `deal_fact_edge` rows.
- Fact node embedding inputs are path-prepended and persisted (`embedding_input`, `content_embedding`).
- Tree materialization now enforces:
  - required `negatives` child bucket,
  - persona subchild nodes (`kind=persona_subchild`, `use_for_global_similarity=false`),
  - child `signal_embedding` from subchild weighted centroids,
  - child `anchor_embedding` from keyword-term vectors,
  - root `centroid_embedding` from weighted child signal vectors,
  - delta/drift support (`delta` child + root `drift_embedding`) when prior revision exists.
- Online keyword clustering now merges terms into existing clusters using cosine threshold (DSU-like online behavior).
- Offline keyword reconcile is now available as an explicit job for global cluster consolidation.
- Hybrid retrieval now has SQL support for PDF-style 2D opportunity/risk coordinates:
  - `public.deal_intel_match_similarity_2d(...)`.

## Added Migration

- `supabase/migrations/027_deal_intel_similarity_2d_rpc.sql`
  - Adds `public.deal_intel_match_similarity_2d(...)`
  - Computes:
    - opportunity similarity from weighted child-signal overlap
    - risk similarity from `negatives` child vector overlap

## Remaining Intentional Simplifications

- Child narrative “2-3 lines” uses deterministic truncation of aggregated text; not a dedicated summarizer model pass.
- Delta node currently compares latest run to previous snapshot root centroid; no multi-hop revision chain analytics.
- Offline clustering is threshold-based transitive merge over existing cluster vectors; this is practical parity with “offline reconcile” but not strict HDBSCAN unless swapped behind the same interface.

## Operational Scripts

- `npm run deal-intel:embed-facts`
- `npm run deal-intel:keywords`
- `npm run deal-intel:keywords:offline`
- `npm run deal-intel:validate-parity -- --deal-id <uuid>`

