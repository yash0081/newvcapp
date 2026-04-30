-- Live assistant: meeting notes bullets (sectioned, mergeable, attributable)

create schema if not exists deal_intel;

create table if not exists deal_intel.meeting_notes_state (
  meeting_id uuid primary key references deal_intel.meeting_session(id) on delete cascade,
  last_notes_tick_at timestamptz,
  last_refine_at timestamptz,
  last_claim_watermark_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists deal_intel.meeting_note_bullet (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  section text not null default 'other',
  text text not null,
  t_ms int not null default 0 check (t_ms >= 0),
  importance_score double precision not null default 0 check (importance_score >= 0),
  source_claim_ids uuid[] not null default '{}'::uuid[],
  parent_bullet_id uuid references deal_intel.meeting_note_bullet(id) on delete set null,
  embedding extensions.vector(768),
  embedding_model text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_note_bullet_dedupe
  on deal_intel.meeting_note_bullet(meeting_id, dedupe_key);
create index if not exists deal_intel_meeting_note_bullet_meeting_section_time
  on deal_intel.meeting_note_bullet(meeting_id, section, t_ms desc);
create index if not exists deal_intel_meeting_note_bullet_meeting_section_updated
  on deal_intel.meeting_note_bullet(meeting_id, section, updated_at desc);
create index if not exists deal_intel_meeting_note_bullet_parent_idx
  on deal_intel.meeting_note_bullet(parent_bullet_id);

create index if not exists deal_intel_meeting_note_bullet_embedding_hnsw
  on deal_intel.meeting_note_bullet using hnsw (embedding extensions.vector_cosine_ops)
  with (m='16', ef_construction='64')
  where embedding is not null;

drop trigger if exists deal_intel_meeting_note_bullet_updated_at on deal_intel.meeting_note_bullet;
create trigger deal_intel_meeting_note_bullet_updated_at
  before update on deal_intel.meeting_note_bullet
  for each row execute function deal_intel.set_updated_at();

drop trigger if exists deal_intel_meeting_notes_state_updated_at on deal_intel.meeting_notes_state;
create trigger deal_intel_meeting_notes_state_updated_at
  before update on deal_intel.meeting_notes_state
  for each row execute function deal_intel.set_updated_at();

-- Vector match: top-k bullets within meeting+section
create or replace function deal_intel.match_meeting_note_bullets(
  p_meeting_id uuid,
  p_section text,
  p_query_embedding extensions.vector(768),
  p_k int default 8
)
returns table(id uuid, parent_bullet_id uuid, text text, t_ms int, importance_score double precision, distance double precision)
language sql
stable
as $$
  select b.id, b.parent_bullet_id, b.text, b.t_ms, b.importance_score, (b.embedding <=> p_query_embedding)::double precision as distance
  from deal_intel.meeting_note_bullet b
  where b.meeting_id = p_meeting_id
    and b.section = coalesce(p_section, 'other')
    and b.embedding is not null
  order by b.embedding <=> p_query_embedding
  limit greatest(1, least(48, coalesce(p_k, 8)));
$$;

create or replace function public.deal_intel_match_meeting_note_bullets(
  p_meeting_id uuid,
  p_section text,
  p_query_embedding extensions.vector(768),
  p_k int default 8
)
returns table(id uuid, parent_bullet_id uuid, text text, t_ms int, importance_score double precision, distance double precision)
language sql
security definer
set search_path = deal_intel, public, extensions
as $$
  select * from deal_intel.match_meeting_note_bullets(p_meeting_id, p_section, p_query_embedding, p_k);
$$;

grant execute on function public.deal_intel_match_meeting_note_bullets(uuid, text, extensions.vector(768), int) to service_role;

alter table deal_intel.meeting_note_bullet enable row level security;
alter table deal_intel.meeting_notes_state enable row level security;

drop policy if exists "deal_intel.meeting_note_bullet read" on deal_intel.meeting_note_bullet;
create policy "deal_intel.meeting_note_bullet read"
  on deal_intel.meeting_note_bullet for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_note_bullet write" on deal_intel.meeting_note_bullet;
create policy "deal_intel.meeting_note_bullet write"
  on deal_intel.meeting_note_bullet
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_notes_state read" on deal_intel.meeting_notes_state;
create policy "deal_intel.meeting_notes_state read"
  on deal_intel.meeting_notes_state for select
  using (deal_intel.user_can_access_meeting(meeting_id));
drop policy if exists "deal_intel.meeting_notes_state write" on deal_intel.meeting_notes_state;
create policy "deal_intel.meeting_notes_state write"
  on deal_intel.meeting_notes_state
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

grant select, insert, update, delete on deal_intel.meeting_note_bullet to authenticated, service_role;
grant select, insert, update, delete on deal_intel.meeting_notes_state to authenticated, service_role;

