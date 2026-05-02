create schema if not exists deal_intel;

alter table if exists deal_intel.document_generation_type
  add column if not exists output_format text not null default 'markdown';

update deal_intel.document_generation_type
set output_format = 'markdown'
where output_format is null or output_format = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_generation_type_output_format_check'
      and conrelid = 'deal_intel.document_generation_type'::regclass
  ) then
    alter table deal_intel.document_generation_type
      add constraint document_generation_type_output_format_check
      check (output_format = any (array['markdown','docx','pdf','text']::text[]));
  end if;
end $$;
