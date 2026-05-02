create table if not exists deal_intel.custom_workflow_definition (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  trigger_hint text not null default '',
  steps jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deal_intel_custom_workflow_definition_user_name
  on deal_intel.custom_workflow_definition(user_id, lower(name));

drop trigger if exists deal_intel_custom_workflow_definition_updated_at on deal_intel.custom_workflow_definition;
create trigger deal_intel_custom_workflow_definition_updated_at
before update on deal_intel.custom_workflow_definition
for each row execute function deal_intel.set_updated_at();

create table if not exists deal_intel.custom_workflow_run (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references deal_intel.custom_workflow_definition(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id uuid references deal_intel.deal(id) on delete set null,
  status text not null default 'running' check (status in ('running','done','failed')),
  input text not null default '',
  summary text not null default '',
  step_results jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deal_intel_custom_workflow_run_user_created
  on deal_intel.custom_workflow_run(user_id, created_at desc);
create index if not exists deal_intel_custom_workflow_run_workflow_created
  on deal_intel.custom_workflow_run(workflow_id, created_at desc);

drop trigger if exists deal_intel_custom_workflow_run_updated_at on deal_intel.custom_workflow_run;
create trigger deal_intel_custom_workflow_run_updated_at
before update on deal_intel.custom_workflow_run
for each row execute function deal_intel.set_updated_at();

alter table deal_intel.custom_workflow_definition enable row level security;
alter table deal_intel.custom_workflow_run enable row level security;

drop policy if exists "deal_intel.custom_workflow_definition own" on deal_intel.custom_workflow_definition;
create policy "deal_intel.custom_workflow_definition own"
  on deal_intel.custom_workflow_definition
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "deal_intel.custom_workflow_run own" on deal_intel.custom_workflow_run;
create policy "deal_intel.custom_workflow_run own"
  on deal_intel.custom_workflow_run
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on deal_intel.custom_workflow_definition to authenticated, service_role;
grant select, insert, update, delete on deal_intel.custom_workflow_run to authenticated, service_role;
