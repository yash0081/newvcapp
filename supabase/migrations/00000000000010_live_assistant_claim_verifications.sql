-- Live assistant: claim verification (deal match + optional grounded web research)

create schema if not exists deal_intel;

do $$ begin
  create type deal_intel.meeting_claim_auto_verdict as enum ('aligns','contradicts','new','inconclusive');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type deal_intel.meeting_claim_research_verdict as enum ('supports','contradicts','inconclusive');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type deal_intel.meeting_claim_verification_stage as enum ('auto_pending','auto_done','research_pending','research_done','failed');
exception
  when duplicate_object then null;
end $$;

create table if not exists deal_intel.meeting_claim_verification (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references deal_intel.meeting_session(id) on delete cascade,
  claim_id uuid not null references deal_intel.meeting_claim(id) on delete cascade,
  stage deal_intel.meeting_claim_verification_stage not null default 'auto_pending',
  auto_verdict deal_intel.meeting_claim_auto_verdict,
  auto_summary text,
  auto_evidence jsonb not null default '[]'::jsonb,
  research_verdict deal_intel.meeting_claim_research_verdict,
  research_summary text,
  research_citations jsonb not null default '[]'::jsonb,
  requested_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_meeting_claim_verification_meeting_claim
  on deal_intel.meeting_claim_verification(meeting_id, claim_id);

create index if not exists deal_intel_meeting_claim_verification_meeting_updated_idx
  on deal_intel.meeting_claim_verification(meeting_id, updated_at desc);

drop trigger if exists deal_intel_meeting_claim_verification_updated_at on deal_intel.meeting_claim_verification;
create trigger deal_intel_meeting_claim_verification_updated_at
  before update on deal_intel.meeting_claim_verification
  for each row execute function deal_intel.set_updated_at();

alter table deal_intel.meeting_assistant_event
  drop constraint if exists meeting_assistant_event_kind_check;

alter table deal_intel.meeting_assistant_event
  add constraint meeting_assistant_event_kind_check
  check ((kind = any (array[
    'contradiction'::text,
    'crm_fact'::text,
    'key_point'::text,
    'suggested_question'::text,
    'action_prompt'::text,
    'claim_verification'::text
  ])));

alter table deal_intel.meeting_claim_verification enable row level security;

drop policy if exists "deal_intel.meeting_claim_verification read" on deal_intel.meeting_claim_verification;
create policy "deal_intel.meeting_claim_verification read"
  on deal_intel.meeting_claim_verification for select
  using (deal_intel.user_can_access_meeting(meeting_id));

drop policy if exists "deal_intel.meeting_claim_verification write" on deal_intel.meeting_claim_verification;
create policy "deal_intel.meeting_claim_verification write"
  on deal_intel.meeting_claim_verification
  using (deal_intel.user_can_access_meeting(meeting_id))
  with check (deal_intel.user_can_access_meeting(meeting_id));

grant select, insert, update, delete on deal_intel.meeting_claim_verification to authenticated, service_role;
