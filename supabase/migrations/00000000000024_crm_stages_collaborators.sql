create table if not exists deal_intel.crm_stage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  label text not null,
  position int not null default 0,
  is_default boolean not null default false,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, key)
);

create unique index if not exists crm_stage_one_default_per_user
  on deal_intel.crm_stage(user_id)
  where is_default;

drop trigger if exists crm_stage_updated_at on deal_intel.crm_stage;
create trigger crm_stage_updated_at
before update on deal_intel.crm_stage
for each row
execute function deal_intel.set_updated_at();

create table if not exists deal_intel.deal_collaborator (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deal_intel.deal(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner','admin','editor','viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(deal_id, user_id)
);

create index if not exists deal_collaborator_deal_idx
  on deal_intel.deal_collaborator(deal_id);

drop trigger if exists deal_collaborator_updated_at on deal_intel.deal_collaborator;
create trigger deal_collaborator_updated_at
before update on deal_intel.deal_collaborator
for each row
execute function deal_intel.set_updated_at();

alter table deal_intel.crm_stage enable row level security;
alter table deal_intel.deal_collaborator enable row level security;

drop policy if exists "crm_stage own" on deal_intel.crm_stage;
create policy "crm_stage own"
  on deal_intel.crm_stage for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "deal_collaborator own deal" on deal_intel.deal_collaborator;
create policy "deal_collaborator own deal"
  on deal_intel.deal_collaborator for all
  using (
    exists (
      select 1 from deal_intel.deal d
      where d.id = deal_collaborator.deal_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from deal_intel.deal d
      where d.id = deal_collaborator.deal_id
        and d.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on deal_intel.crm_stage to authenticated, service_role;
grant select, insert, update, delete on deal_intel.deal_collaborator to authenticated, service_role;
