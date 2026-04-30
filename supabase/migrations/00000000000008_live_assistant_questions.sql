-- Live assistant: question engine persistence (claims, assumptions, tracked questions, matches, templates, spans)

create schema if not exists deal_intel;

-- Question lifecycle state
do $$ begin
  create type deal_intel.meeting_question_state as enum (
    'unanswered',
    'partially_answered',
    'answered',
    'contradicted',
    'needs_followup'
  );
exception
  when duplicate_object then null;
end $$;

-- Provenance for ranked question feed
do $$ begin
  create type deal_intel.meeting_question_provenance as enum (
    'assumption_inversion',
    'similar_company',
    'low_evidence',
    'contradiction',
    'coverage_prompt',
    'manual'
  );
exception
  when duplicate_object then null;
end $$;

-- Relation label from second-stage matcher
do $$ begin
  create type deal_intel.meeting_question_claim_relation as enum (
    'answers',
    'partial',
    'contradicts',
    'irrelevant'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists deal_intel.meeting_question_engine_state (
  meeting_id uuid primary key references deal_intel.meeting_session(id) on delete cascade,
  last_assumption_run_at timestamptz,
  last_similar_hydrate_at timestamptz,
  last_match_batch_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists deal_intel.meeting_claim (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  chunk_id uuid references deal_intel.meeting_semantic_chunk(id) on delete set null,
  speaker text,
  text text not null,
  t_start_ms int not null default 0 check (t_start_ms >= 0),
  t_end_ms int not null default 0 check (t_end_ms >= 0),
  claim_embedding extensions.vector(768),
  embedding_model text,
  confidence double precision not null default 0.5 check (confidence >= 0 and confidence <= 1),
  section_labels text[] not null default '{}'::text[],
  raw_classifier_output jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_claim_dedupe
  on deal_intel.meeting_claim(meeting_id, dedupe_key);
create index if not exists deal_intel_meeting_claim_meeting_updated_idx
  on deal_intel.meeting_claim(meeting_id, updated_at desc);

drop trigger if exists deal_intel_meeting_claim_updated_at on deal_intel.meeting_claim;
create trigger deal_intel_meeting_claim_updated_at
  before update on deal_intel.meeting_claim
  for each row execute function deal_intel.set_updated_at();

create index if not exists deal_intel_meeting_claim_embedding_hnsw
  on deal_intel.meeting_claim using hnsw (claim_embedding extensions.vector_cosine_ops)
  with (m='16', ef_construction='64')
  where claim_embedding is not null;

create table if not exists deal_intel.meeting_claim_assumption (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  claim_id uuid not null references deal_intel.meeting_claim(id) on delete cascade,
  assumption_text text not null,
  dependency_type text not null default 'implicit',
  confidence double precision not null default 0.5 check (confidence >= 0 and confidence <= 1),
  stable_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_claim_assumption_stable
  on deal_intel.meeting_claim_assumption(claim_id, stable_key);

create table if not exists deal_intel.meeting_tracked_question (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  text text not null,
  section text not null default 'other',
  question_embedding extensions.vector(768),
  question_embedding_model text,
  importance_weight double precision not null default 0.5 check (importance_weight >= 0 and importance_weight <= 2),
  state deal_intel.meeting_question_state not null default 'unanswered',
  provenance deal_intel.meeting_question_provenance not null default 'manual',
  venue text not null default 'in_meeting' check (venue in ('in_meeting', 'memo_prep')),
  similar_deal_id uuid references deal_intel.deal(id) on delete set null,
  template_id uuid,
  dedupe_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_tracked_question_dedupe
  on deal_intel.meeting_tracked_question(meeting_id, dedupe_key);

create index if not exists deal_intel_meeting_tracked_question_meeting_state_idx
  on deal_intel.meeting_tracked_question(meeting_id, state, updated_at desc);

create index if not exists deal_intel_meeting_tracked_question_embedding_hnsw
  on deal_intel.meeting_tracked_question using hnsw (question_embedding extensions.vector_cosine_ops)
  with (m='16', ef_construction='64')
  where question_embedding is not null;

create table if not exists deal_intel.meeting_question_claim_match (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references deal_intel.meeting_tracked_question(id) on delete cascade,
  claim_id uuid not null references deal_intel.meeting_claim(id) on delete cascade,
  relation deal_intel.meeting_question_claim_relation not null,
  classifier_version text not null default 'v1-heuristic',
  scores jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists deal_intel_meeting_question_claim_match_q_created
  on deal_intel.meeting_question_claim_match(question_id, created_at desc);

create table if not exists deal_intel.similar_deal_question_template (
  id uuid primary key default gen_random_uuid(),
  source_deal_id uuid not null references deal_intel.deal(id) on delete cascade,
  text text not null,
  section text not null default 'other',
  embedding extensions.vector(768),
  embedding_model text,
  importance_weight double precision not null default 0.5 check (importance_weight >= 0 and importance_weight <= 2),
  is_meeting_question boolean not null default true,
  stage_at_capture text,
  business_model_at_capture text,
  usage_stats jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists deal_intel_similar_deal_question_template_dedupe
  on deal_intel.similar_deal_question_template(source_deal_id, dedupe_key);

create index if not exists deal_intel_similar_deal_question_embedding_hnsw
  on deal_intel.similar_deal_question_template using hnsw (embedding extensions.vector_cosine_ops)
  with (m='16', ef_construction='64')
  where embedding is not null;

-- FK template_id after table exists
alter table deal_intel.meeting_tracked_question
  drop constraint if exists meeting_tracked_question_template_id_fkey;
alter table deal_intel.meeting_tracked_question
  add constraint meeting_tracked_question_template_id_fkey
  foreign key (template_id) references deal_intel.similar_deal_question_template(id) on delete set null;

create table if not exists deal_intel.meeting_question_span (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  t_start_ms int not null default 0 check (t_start_ms >= 0),
  t_end_ms int not null default 0 check (t_end_ms >= 0),
  text text not null,
  is_question_score double precision not null default 0 check (is_question_score >= 0 and is_question_score <= 1),
  intent_classifier_version text not null default 'v1-regex',
  merged_from_span_ids uuid[] not null default '{}'::uuid[],
  linked_tracked_question_id uuid references deal_intel.meeting_tracked_question(id) on delete set null,
  confirmed_by_llm boolean not null default false,
  dedupe_key text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_question_span_dedupe
  on deal_intel.meeting_question_span(meeting_id, dedupe_key);

create index if not exists deal_intel_meeting_question_span_meeting_time
  on deal_intel.meeting_question_span(meeting_id, t_start_ms);

-- jsonb array of floats -> vector(768)
create or replace function deal_intel.jsonb_to_vector768(j jsonb)
returns extensions.vector(768)
language sql
immutable
as $$
  select (
    '[' || coalesce(
      (select string_agg(elem::text, ',') from jsonb_array_elements(j) as t(elem)),
      ''
    ) || ']'
  )::extensions.vector(768);
$$;

-- Batched top-k claim retrieval per question (cosine distance via <=> operator)
create or replace function deal_intel.match_meeting_claims_for_questions(
  p_meeting_id uuid,
  p_queries jsonb,
  p_k int default 8
)
returns table(question_id uuid, claim_id uuid, distance double precision)
language sql
stable
as $$
  with qs as (
    select
      (elem->>'question_id')::uuid as qid,
      deal_intel.jsonb_to_vector768(elem->'embedding') as qvec
    from jsonb_array_elements(coalesce(p_queries, '[]'::jsonb)) elem
    where elem ? 'question_id' and elem ? 'embedding'
  )
  select q.qid, c.id, (c.claim_embedding <=> q.qvec)::double precision as distance
  from qs q
  cross join lateral (
    select mc.id, mc.claim_embedding
    from deal_intel.meeting_claim mc
    where mc.meeting_id = p_meeting_id
      and mc.claim_embedding is not null
    order by mc.claim_embedding <=> q.qvec
    limit greatest(1, least(32, coalesce(p_k, 8)))
  ) c;
$$;

create or replace function public.deal_intel_match_meeting_claims_for_questions(
  p_meeting_id uuid,
  p_queries jsonb,
  p_k int default 8
)
returns table(question_id uuid, claim_id uuid, distance double precision)
language sql
security definer
set search_path = deal_intel, public, extensions
as $$
  select * from deal_intel.match_meeting_claims_for_questions(p_meeting_id, p_queries, p_k);
$$;

grant execute on function public.deal_intel_match_meeting_claims_for_questions(uuid, jsonb, int) to service_role;

-- Top-k similar question templates restricted to candidate deals (vector ANN + filter)
create or replace function deal_intel.match_similar_deal_question_templates(
  p_source_deal_ids uuid[],
  p_query_embedding extensions.vector(768),
  p_k int default 12
)
returns table(id uuid, source_deal_id uuid, text text, section text, distance double precision)
language sql
stable
as $$
  select t.id, t.source_deal_id, t.text, t.section, (t.embedding <=> p_query_embedding)::double precision as distance
  from deal_intel.similar_deal_question_template t
  where t.embedding is not null
    and p_source_deal_ids is not null
    and t.source_deal_id = any(p_source_deal_ids)
  order by t.embedding <=> p_query_embedding
  limit greatest(1, least(48, coalesce(p_k, 12)));
$$;

create or replace function public.deal_intel_match_similar_deal_question_templates(
  p_source_deal_ids uuid[],
  p_query_embedding extensions.vector(768),
  p_k int default 12
)
returns table(id uuid, source_deal_id uuid, text text, section text, distance double precision)
language sql
security definer
set search_path = deal_intel, public, extensions
as $$
  select * from deal_intel.match_similar_deal_question_templates(p_source_deal_ids, p_query_embedding, p_k);
$$;

grant execute on function public.deal_intel_match_similar_deal_question_templates(uuid[], extensions.vector(768), int) to service_role;
grant execute on function public.deal_intel_match_similar_deal_question_templates(uuid[], extensions.vector(768), int) to authenticated;

alter table deal_intel.meeting_question_engine_state enable row level security;
alter table deal_intel.meeting_claim enable row level security;
alter table deal_intel.meeting_claim_assumption enable row level security;
alter table deal_intel.meeting_tracked_question enable row level security;
alter table deal_intel.meeting_question_claim_match enable row level security;
alter table deal_intel.similar_deal_question_template enable row level security;
alter table deal_intel.meeting_question_span enable row level security;

drop policy if exists "deal_intel.meeting_question_engine_state read" on deal_intel.meeting_question_engine_state;
create policy "deal_intel.meeting_question_engine_state read"
  on deal_intel.meeting_question_engine_state for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_question_engine_state write" on deal_intel.meeting_question_engine_state;
create policy "deal_intel.meeting_question_engine_state write"
  on deal_intel.meeting_question_engine_state
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_claim read" on deal_intel.meeting_claim;
create policy "deal_intel.meeting_claim read"
  on deal_intel.meeting_claim for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_claim write" on deal_intel.meeting_claim;
create policy "deal_intel.meeting_claim write"
  on deal_intel.meeting_claim
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_claim_assumption read" on deal_intel.meeting_claim_assumption;
create policy "deal_intel.meeting_claim_assumption read"
  on deal_intel.meeting_claim_assumption for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_claim_assumption write" on deal_intel.meeting_claim_assumption;
create policy "deal_intel.meeting_claim_assumption write"
  on deal_intel.meeting_claim_assumption
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_tracked_question read" on deal_intel.meeting_tracked_question;
create policy "deal_intel.meeting_tracked_question read"
  on deal_intel.meeting_tracked_question for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_tracked_question write" on deal_intel.meeting_tracked_question;
create policy "deal_intel.meeting_tracked_question write"
  on deal_intel.meeting_tracked_question
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_question_claim_match read" on deal_intel.meeting_question_claim_match;
create policy "deal_intel.meeting_question_claim_match read"
  on deal_intel.meeting_question_claim_match for select
  using (
    exists (
      select 1 from deal_intel.meeting_tracked_question q
      where q.id = meeting_question_claim_match.question_id
        and deal_intel.user_can_access_meeting(q.meeting_id)
    )
  );
drop policy if exists "deal_intel.meeting_question_claim_match write" on deal_intel.meeting_question_claim_match;
create policy "deal_intel.meeting_question_claim_match write"
  on deal_intel.meeting_question_claim_match
  using (
    exists (
      select 1 from deal_intel.meeting_tracked_question q
      where q.id = meeting_question_claim_match.question_id
        and deal_intel.user_can_access_meeting(q.meeting_id)
    )
  )
  with check (
    exists (
      select 1 from deal_intel.meeting_tracked_question q
      where q.id = meeting_question_claim_match.question_id
        and deal_intel.user_can_access_meeting(q.meeting_id)
    )
  );

-- Templates: readable if user owns source deal
drop policy if exists "deal_intel.similar_deal_question_template read" on deal_intel.similar_deal_question_template;
create policy "deal_intel.similar_deal_question_template read"
  on deal_intel.similar_deal_question_template for select
  using (
    exists (
      select 1 from deal_intel.deal d
      where d.id = similar_deal_question_template.source_deal_id
        and d.user_id = auth.uid()
    )
  );
drop policy if exists "deal_intel.similar_deal_question_template write" on deal_intel.similar_deal_question_template;
create policy "deal_intel.similar_deal_question_template write"
  on deal_intel.similar_deal_question_template
  using (
    exists (
      select 1 from deal_intel.deal d
      where d.id = similar_deal_question_template.source_deal_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from deal_intel.deal d
      where d.id = similar_deal_question_template.source_deal_id
        and d.user_id = auth.uid()
    )
  );

drop policy if exists "deal_intel.meeting_question_span read" on deal_intel.meeting_question_span;
create policy "deal_intel.meeting_question_span read"
  on deal_intel.meeting_question_span for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_question_span write" on deal_intel.meeting_question_span;
create policy "deal_intel.meeting_question_span write"
  on deal_intel.meeting_question_span
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

grant select, insert, update, delete on deal_intel.meeting_question_engine_state to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_claim to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_claim_assumption to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_tracked_question to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_question_claim_match to authenticated, service_role;
grant select, insert, update, delete on deal_intel.similar_deal_question_template to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_question_span to authenticated, service_role;
