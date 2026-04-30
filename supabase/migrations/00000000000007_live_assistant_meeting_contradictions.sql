-- Live assistant: meeting-native contradiction persistence layer
-- Adds semantic chunks, KPI observations, contradiction rows, and batch run bookkeeping.

create schema if not exists deal_intel;

create table if not exists deal_intel.meeting_semantic_chunk (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  speaker text,
  t_start_ms int not null check (t_start_ms >= 0),
  t_end_ms int not null check (t_end_ms >= 0),
  text text not null,
  finalize_reason text not null,
  source_segment_keys text[] not null default '{}'::text[],
  created_at timestamptz not null default now()
);

create index if not exists deal_intel_meeting_semantic_chunk_meeting_time_idx
  on deal_intel.meeting_semantic_chunk(meeting_id, t_start_ms);

create table if not exists deal_intel.meeting_kpi_observation (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  chunk_id uuid references deal_intel.meeting_semantic_chunk(id) on delete set null,
  section text not null default 'other' check (section in ('solution','traction','problem','other')),
  metric_key text not null,
  raw_value_text text,
  normalized_value_number double precision,
  unit text not null default 'unknown' check (unit in ('usd','percent','count','unknown')),
  confidence double precision not null default 0.5 check (confidence >= 0 and confidence <= 1),
  source_text text not null,
  dedupe_key text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_kpi_observation_dedupe_key
  on deal_intel.meeting_kpi_observation(meeting_id, dedupe_key);
create index if not exists deal_intel_meeting_kpi_observation_meeting_metric_time_idx
  on deal_intel.meeting_kpi_observation(meeting_id, metric_key, created_at desc);

create table if not exists deal_intel.meeting_contradiction (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  section text not null default 'other' check (section in ('solution','traction','problem','other')),
  kind text not null check (kind in ('kpi_drift','segment_drift','external_claim','commitment')),
  confidence double precision not null default 0.5 check (confidence >= 0 and confidence <= 1),
  severity text not null default 'low' check (severity in ('low','med','high')),
  founder_quote text not null,
  records_quote text,
  records_source jsonb not null default '{}'::jsonb,
  suggested_followup_question text,
  explanation_jsonb jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null
);

create unique index if not exists deal_intel_meeting_contradiction_dedupe_key
  on deal_intel.meeting_contradiction(meeting_id, dedupe_key);

create table if not exists deal_intel.meeting_contradiction_batch (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  section text not null default 'other' check (section in ('solution','traction','problem','other')),
  window_start_ms int not null default 0 check (window_start_ms >= 0),
  window_end_ms int not null default 0 check (window_end_ms >= 0),
  input_hash text not null,
  model text,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  error text,
  created_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_contradiction_batch_input_hash
  on deal_intel.meeting_contradiction_batch(meeting_id, section, input_hash);

create index if not exists deal_intel_meeting_contradiction_batch_meeting_created_idx
  on deal_intel.meeting_contradiction_batch(meeting_id, created_at desc);

-- RLS: reuse existing meeting access policy helper.
alter table deal_intel.meeting_semantic_chunk enable row level security;
alter table deal_intel.meeting_kpi_observation enable row level security;
alter table deal_intel.meeting_contradiction enable row level security;
alter table deal_intel.meeting_contradiction_batch enable row level security;

drop policy if exists "deal_intel.meeting_semantic_chunk read" on deal_intel.meeting_semantic_chunk;
create policy "deal_intel.meeting_semantic_chunk read"
  on deal_intel.meeting_semantic_chunk
  for select
  using (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_semantic_chunk write" on deal_intel.meeting_semantic_chunk;
create policy "deal_intel.meeting_semantic_chunk write"
  on deal_intel.meeting_semantic_chunk
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_kpi_observation read" on deal_intel.meeting_kpi_observation;
create policy "deal_intel.meeting_kpi_observation read"
  on deal_intel.meeting_kpi_observation
  for select
  using (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_kpi_observation write" on deal_intel.meeting_kpi_observation;
create policy "deal_intel.meeting_kpi_observation write"
  on deal_intel.meeting_kpi_observation
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_contradiction read" on deal_intel.meeting_contradiction;
create policy "deal_intel.meeting_contradiction read"
  on deal_intel.meeting_contradiction
  for select
  using (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_contradiction write" on deal_intel.meeting_contradiction;
create policy "deal_intel.meeting_contradiction write"
  on deal_intel.meeting_contradiction
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_contradiction_batch read" on deal_intel.meeting_contradiction_batch;
create policy "deal_intel.meeting_contradiction_batch read"
  on deal_intel.meeting_contradiction_batch
  for select
  using (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_contradiction_batch write" on deal_intel.meeting_contradiction_batch;
create policy "deal_intel.meeting_contradiction_batch write"
  on deal_intel.meeting_contradiction_batch
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

