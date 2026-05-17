create table if not exists deal_intel.diligence_matrix_view (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  deal_ids uuid[] not null default '{}',
  column_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists diligence_matrix_view_user_idx
  on deal_intel.diligence_matrix_view(user_id, updated_at desc);

drop trigger if exists diligence_matrix_view_updated_at on deal_intel.diligence_matrix_view;
create trigger diligence_matrix_view_updated_at
  before update on deal_intel.diligence_matrix_view
  for each row execute function deal_intel.set_updated_at();

alter table deal_intel.diligence_matrix_view enable row level security;

drop policy if exists "diligence_matrix_view own" on deal_intel.diligence_matrix_view;
create policy "diligence_matrix_view own"
  on deal_intel.diligence_matrix_view
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on deal_intel.diligence_matrix_view to authenticated, service_role;
