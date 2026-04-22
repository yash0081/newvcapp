-- Optional: backfill deal_pipeline_json_summaries for markdown corpus deals so the
-- pipeline summary table matches normalized data (grid also reads fallbacks in code).
-- Run in Supabase SQL editor as a privileged role. Adjust source filter if needed.
--
-- After any bulk data fix, re-run:
--   npx tsx scripts/backfill-deal-context-nodes.ts --index-deals
-- (or --force --deal-id <uuid> for one deal)

INSERT INTO public.deal_pipeline_json_summaries (deal_id, analysis_id, pipeline_summaries_json)
SELECT
  d.id,
  la.analysis_id,
  jsonb_strip_nulls(
    jsonb_build_object(
      'problem',
      NULLIF(TRIM(COALESCE(dp.problem_statement, '')), ''),
      'solution',
      NULLIF(TRIM(COALESCE(ds.solution_summary, '')), ''),
      'traction',
      NULLIF(
        TRIM(
          COALESCE(
            NULLIF(TRIM(COALESCE(dt.benchmark_context, '')), ''),
            NULLIF(TRIM(COALESCE(dt.inferred_stage, '')), ''),
            NULLIF(TRIM(COALESCE(dt.revenue_data, '')), ''),
            NULLIF(TRIM(COALESCE(dt.growth_signals, '')), '')
          )
        ),
        ''
      ),
      'founder',
      NULLIF(TRIM(COALESCE(fo.team_text, '')), '')
    )
  )
FROM public.deals d
INNER JOIN LATERAL (
  SELECT id AS analysis_id
  FROM public.deal_analyses
  WHERE deal_id = d.id
  ORDER BY run_at DESC NULLS LAST
  LIMIT 1
) la ON true
LEFT JOIN public.deal_problem dp ON dp.deal_id = d.id AND dp.analysis_id = la.analysis_id
LEFT JOIN public.deal_solution ds ON ds.deal_id = d.id AND ds.analysis_id = la.analysis_id
LEFT JOIN public.deal_traction dt ON dt.deal_id = d.id AND dt.analysis_id = la.analysis_id
LEFT JOIN LATERAL (
  SELECT
    string_agg(
      TRIM(
        COALESCE(f.name, '')
        || CASE WHEN f.role IS NOT NULL AND TRIM(f.role) <> '' THEN ' — ' || f.role ELSE '' END
        || CASE
          WHEN f.enrichment_raw IS NOT NULL AND (f.enrichment_raw ? 'background')
            THEN ': ' || (f.enrichment_raw->>'background')
          ELSE ''
        END
      ),
      E'\n'
      ORDER BY f.created_at
    ) AS team_text
  FROM public.founders f
  WHERE f.deal_id = d.id
) fo ON true
WHERE d.source = 'invested-companies-md'
ON CONFLICT (analysis_id) DO UPDATE SET
  pipeline_summaries_json = EXCLUDED.pipeline_summaries_json;
