-- Claim supersession: when a guest later corrects a number (e.g. "$20B" → "$215B"), the
-- matcher records the correction by pointing the original `meeting_claim` row at the
-- newer claim that answered the contradiction-followup question. Late background jobs
-- (slow reasoning, auto-verify, deep contradictions, KPI middle path) read this column
-- at entry and skip emit so the user doesn't see a stale duplicate "Possible
-- contradiction" minutes after they already heard the corrected answer.
--
-- See lib/live-assistant/question-match.ts for the writer and lib/live-assistant/{
--   reasoning, claim-verify-auto, deep-contradictions, kpi-middle-path}.ts for honor.

alter table deal_intel.meeting_claim
  add column if not exists superseded_by_claim_id uuid
    references deal_intel.meeting_claim(id) on delete set null;

alter table deal_intel.meeting_claim
  add column if not exists superseded_at timestamptz;

create index if not exists deal_intel_meeting_claim_superseded_idx
  on deal_intel.meeting_claim(meeting_id, superseded_by_claim_id)
  where superseded_by_claim_id is not null;
