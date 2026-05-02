-- Claim supersession: when a guest later corrects a number (e.g. "$20B" → "$215B"), the
-- canonical verifier can point the original `meeting_claim` row at the newer correction.
-- This column is retained for historical meeting data and future answer-resolution flows
-- even though the legacy slow/auto/deep/KPI contradiction paths have been removed.

alter table deal_intel.meeting_claim
  add column if not exists superseded_by_claim_id uuid
    references deal_intel.meeting_claim(id) on delete set null;

alter table deal_intel.meeting_claim
  add column if not exists superseded_at timestamptz;

create index if not exists deal_intel_meeting_claim_superseded_idx
  on deal_intel.meeting_claim(meeting_id, superseded_by_claim_id)
  where superseded_by_claim_id is not null;
