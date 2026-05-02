create table if not exists deal_intel.diligence_matrix_column (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  label text not null,
  description text not null default '',
  data_type text not null default 'text' check (data_type in ('text','number','percent','currency','boolean','json')),
  prompt text not null default '',
  research_enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists diligence_matrix_column_user_label_key
  on deal_intel.diligence_matrix_column(user_id, lower(label));

create table if not exists deal_intel.diligence_matrix_cell (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  deal_id uuid not null references deal_intel.deal(id) on delete cascade,
  column_id uuid not null references deal_intel.diligence_matrix_column(id) on delete cascade,
  status text not null default 'empty' check (status in ('empty','filled','needs_research','researching','error')),
  value_text text,
  value_jsonb jsonb,
  confidence numeric,
  source_kind text not null default 'none' check (source_kind in ('none','internal','research','manual')),
  rationale text,
  citations jsonb not null default '[]'::jsonb,
  research_notes text,
  error_message text,
  filled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deal_id, column_id)
);

create index if not exists diligence_matrix_cell_user_idx
  on deal_intel.diligence_matrix_cell(user_id, updated_at desc);

create index if not exists diligence_matrix_cell_deal_idx
  on deal_intel.diligence_matrix_cell(deal_id);

drop trigger if exists diligence_matrix_column_updated_at on deal_intel.diligence_matrix_column;
create trigger diligence_matrix_column_updated_at
  before update on deal_intel.diligence_matrix_column
  for each row execute function deal_intel.set_updated_at();

drop trigger if exists diligence_matrix_cell_updated_at on deal_intel.diligence_matrix_cell;
create trigger diligence_matrix_cell_updated_at
  before update on deal_intel.diligence_matrix_cell
  for each row execute function deal_intel.set_updated_at();

alter table deal_intel.diligence_matrix_column enable row level security;
alter table deal_intel.diligence_matrix_cell enable row level security;

drop policy if exists "diligence_matrix_column own" on deal_intel.diligence_matrix_column;
create policy "diligence_matrix_column own"
  on deal_intel.diligence_matrix_column
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "diligence_matrix_cell own" on deal_intel.diligence_matrix_cell;
create policy "diligence_matrix_cell own"
  on deal_intel.diligence_matrix_cell
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on deal_intel.diligence_matrix_column to authenticated, service_role;
grant select, insert, update, delete on deal_intel.diligence_matrix_cell to authenticated, service_role;
