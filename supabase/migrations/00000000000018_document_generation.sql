create schema if not exists deal_intel;

create table if not exists deal_intel.document_generation_type (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  output_format text not null default 'markdown',
  description text not null default '',
  instructions text not null default '',
  learned_preferences text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_generation_type_output_format_check check (output_format = any (array['markdown','docx','pdf','text']::text[]))
);

create unique index if not exists deal_intel_document_generation_type_user_name
  on deal_intel.document_generation_type(user_id, (lower(name)));

drop trigger if exists deal_intel_document_generation_type_updated_at on deal_intel.document_generation_type;
create trigger deal_intel_document_generation_type_updated_at
before update on deal_intel.document_generation_type
for each row execute function deal_intel.set_updated_at();

create table if not exists deal_intel.document_generation_reference (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references deal_intel.document_generation_type(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'description',
  filename text,
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint document_generation_reference_kind_check check (kind = any (array['description','template','sample','notes']::text[]))
);

create index if not exists deal_intel_document_generation_reference_type_idx
  on deal_intel.document_generation_reference(type_id, created_at desc);

create table if not exists deal_intel.generated_document_draft (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id uuid references deal_intel.deal(id) on delete set null,
  type_id uuid references deal_intel.document_generation_type(id) on delete set null,
  title text not null default 'Generated document',
  prompt text not null default '',
  content text not null default '',
  status text not null default 'draft',
  missing_info jsonb not null default '[]'::jsonb,
  research_steps jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_document_draft_status_check check (status = any (array['draft','needs_info','ready','archived']::text[]))
);

create index if not exists deal_intel_generated_document_draft_user_created_idx
  on deal_intel.generated_document_draft(user_id, created_at desc);
create index if not exists deal_intel_generated_document_draft_deal_created_idx
  on deal_intel.generated_document_draft(deal_id, created_at desc);

drop trigger if exists deal_intel_generated_document_draft_updated_at on deal_intel.generated_document_draft;
create trigger deal_intel_generated_document_draft_updated_at
before update on deal_intel.generated_document_draft
for each row execute function deal_intel.set_updated_at();

create table if not exists deal_intel.generated_document_feedback (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references deal_intel.generated_document_draft(id) on delete cascade,
  type_id uuid references deal_intel.document_generation_type(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  instruction text not null,
  saved_to_type boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists deal_intel_generated_document_feedback_draft_idx
  on deal_intel.generated_document_feedback(draft_id, created_at desc);

alter table deal_intel.document_generation_type enable row level security;
alter table deal_intel.document_generation_reference enable row level security;
alter table deal_intel.generated_document_draft enable row level security;
alter table deal_intel.generated_document_feedback enable row level security;

drop policy if exists "deal_intel.document_generation_type own" on deal_intel.document_generation_type;
create policy "deal_intel.document_generation_type own"
  on deal_intel.document_generation_type
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "deal_intel.document_generation_reference own" on deal_intel.document_generation_reference;
create policy "deal_intel.document_generation_reference own"
  on deal_intel.document_generation_reference
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "deal_intel.generated_document_draft own" on deal_intel.generated_document_draft;
create policy "deal_intel.generated_document_draft own"
  on deal_intel.generated_document_draft
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "deal_intel.generated_document_feedback own" on deal_intel.generated_document_feedback;
create policy "deal_intel.generated_document_feedback own"
  on deal_intel.generated_document_feedback
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on deal_intel.document_generation_type to authenticated, service_role;
grant select, insert, update, delete on deal_intel.document_generation_reference to authenticated, service_role;
grant select, insert, update, delete on deal_intel.generated_document_draft to authenticated, service_role;
grant select, insert, update, delete on deal_intel.generated_document_feedback to authenticated, service_role;
