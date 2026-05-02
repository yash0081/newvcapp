# Troubleshooting Guide

## Why Manual Deletion from Supabase Database Breaks Things

### The Problem

When you manually delete rows from the Supabase database (via the dashboard or SQL editor), several issues can occur:

1. **Nested Query Failures**: The home page uses nested queries (`emails(...)`) which can fail if:
   - The connection is deleted but emails still exist (orphaned data)
   - RLS policies can't properly evaluate the nested relationship
   - The query structure assumes the connection exists

2. **RLS Policy Evaluation**: Row Level Security policies check for the existence of related records. If you delete a `gmail_connection` manually:
   - The `emails` table RLS policy checks: `EXISTS (SELECT 1 FROM gmail_connections gc WHERE gc.id = gmail_connection_id AND gc.user_id = auth.uid())`
   - If the connection is gone but emails remain, the policy evaluation can fail or behave unexpectedly

3. **Cascade Deletion Timing**: While `ON DELETE CASCADE` should delete emails when connections are deleted, manual deletions might:
   - Not trigger properly if done via SQL editor without proper transaction handling
   - Leave orphaned data if foreign key constraints aren't enforced correctly
   - Cause race conditions if done while the app is running

4. **Active Watch Subscriptions**: If you delete a connection manually:
   - The Gmail watch subscription is NOT stopped (it's still active in Google's system)
   - Webhooks continue to arrive but fail because the connection doesn't exist
   - This wastes resources and can cause errors

### The Solution

**Always use the proper disconnect endpoint** (`/api/gmail/disconnect`) or the "Disconnect Gmail" button in the UI. This ensures:
1. The Gmail watch subscription is stopped properly
2. The connection is deleted cleanly
3. All related emails are cascade-deleted
4. No orphaned data remains

## How to Fix If You've Already Deleted Manually

### Option 1: Clean Up Orphaned Data (SQL)

If you've manually deleted connections and have orphaned emails, run this in Supabase SQL Editor:

```sql
-- Find orphaned emails (emails without a connection)
SELECT e.* FROM emails e
LEFT JOIN gmail_connections gc ON e.gmail_connection_id = gc.id
WHERE gc.id IS NULL;

-- Delete orphaned emails
DELETE FROM emails
WHERE gmail_connection_id NOT IN (SELECT id FROM gmail_connections);
```

### Option 2: Reconnect Gmail

1. If you deleted the connection but the user still exists:
   - Have the user click "Connect Gmail" again
   - This will create a new connection and set up watch subscriptions properly

2. If you deleted the user entirely:
   - The user needs to sign up/login again
   - Then connect Gmail fresh

### Option 3: Stop Active Watch Subscriptions

If you deleted connections but watch subscriptions are still active:

1. You'll need to stop them via Google Cloud Console or Gmail API
2. Or wait for them to expire (they expire after 7 days)
3. The webhook endpoint now handles missing connections gracefully (returns 200 to acknowledge)

## Prevention

1. **Never delete from `gmail_connections` table manually** - always use the disconnect endpoint
2. **Never delete from `auth.users` table manually** - use Supabase Auth methods instead
3. **If you must delete for testing**, use the disconnect endpoint or create a test script that:
   - Stops the watch subscription
   - Deletes the connection
   - Cleans up orphaned emails

## Code Changes Made to Prevent Issues

1. **Separated nested queries**: The home page now queries connections and emails separately to avoid nested query failures
2. **Better error handling**: All queries now check for errors and handle missing data gracefully
3. **Graceful degradation**: If emails can't be fetched, the page still loads and shows "Connect Gmail"
4. **Webhook resilience**: Webhook endpoint handles missing connections gracefully (returns 200 to prevent retries)

## Live Assistant Local Auto-Start

The live assistant can auto-start locally from the host meeting UI instead of requiring a manual worker terminal command.

### Enable local auto-start

Set this env var in your local environment:

```bash
LIVE_ASSISTANT_AUTOSTART_LOCAL=1
```

Auto-start is intentionally limited to local development (`NODE_ENV=development`). If disabled, the host UI shows an explicit reason.

### What to expect

1. Create a meeting and open the host meeting URL (without `?guest=...`)
2. In the host sidebar, click **Enable live assistant**
3. Status should change to `running` and show a worker PID
4. Host will see:
   - **Live transcript** (finalized transcript segments)
   - **Assistant events** (context, contradictions, action prompts)
5. Guest still joins using the guest link and does not need an account

### Common issues

- **Toggle fails with disabled message**: `LIVE_ASSISTANT_AUTOSTART_LOCAL` is not set to `1` (or process is not running in local development mode).
- **No transcript/events**: confirm host enabled assistant and both host + guest are connected with mic permission.
- **Contradiction checks missing**: worker may be running without Vertex auth; transcript can still work while advanced checks are limited.

### Echo / garbled transcript when testing with two browser tabs (same PC)

The meeting UI uses LiveKit’s **RoomAudioRenderer**, which plays **every remote participant’s audio** in that tab. If you open **host + guest in two tabs on one machine**, both tabs play each other’s audio: you hear **double playback**, and your **microphone can pick up speaker output**, which sounds like echo and **hurts STT quality**.

**Mitigations**

- Prefer **headphones** on at least one participant when testing host + guest on one machine.
- Use **two physical devices** for host vs guest when possible.

**Chrome (regular profile vs incognito on one laptop)**

There is no Chrome toggle that magically removes acoustic echo; echo comes from **speaker sound leaking into the mic**. Useful habits:

- **Two tabs on one PC**: **Mute one tab’s audio** (right‑click the tab → *Mute site*) so only one tab plays the remote participant, **or** use headphones so speaker bleed doesn’t hit the mic.
- **Incognito guest**: Incognito does not fix echo by itself; it only isolates cookies/session. You still need headphones, tab mute, or separate devices.
- **macOS**: Pick one output device (*Sound* → *Output*)—avoid splitting output across laptop speakers and monitor speakers simultaneously while testing.
- **Mic**: Use the built‑in mic only if you must; a headset mic picks up far less room noise than laptop speakers playing the remote guest.

This is normal WebRTC behavior, not a duplicate bug in `RoomAudioRenderer` mounting—the worker process still attaches **one transcription pipeline per enabled assistant meeting** (`worker-manager` keys workers by `meetingId`).

### Meeting notes pipeline (grounding / hallucinations)

Notes are generated server-side from `meeting_claim` rows. Relevant env vars:

| Variable | Effect |
|----------|--------|
| `LIVE_ASSISTANT_NOTES_MODE` | `llm` (default): memo-style LLM bullets + soft grounding (no verbatim transcript splice). `hybrid`: same bullet path as `llm` (claim grouping may differ). `extractive`: clipped claim text + verbatim-style grounding—avoid for “pretty” investor notes. |
| `LIVE_ASSISTANT_NOTES_REFINE` | Must be `1` to enable the **second** LLM polish pass (`notes-refine`). Default is **off** (opt-in). After refine, grounding runs again so polish cannot drift off-source. |
| `LIVE_ASSISTANT_NOTES_ENTAILMENT` | Set `1` for an extra LLM check that bullets are fully entailed by source quotes. |
| `LIVE_ASSISTANT_NOTES_TICK_MS` | How often the worker enqueues a notes tick (default **4000** ms, clamped 2500–12000). |
| `LIVE_ASSISTANT_Q_TICK_MS` | How often the question engine job is enqueued (default **4000** ms, clamped 2500–12000). |
| `LIVE_ASSISTANT_QUESTION_HYDRATE_COOLDOWN_MS` | Min interval between **peer-style question** LLM runs (default **36s**, clamped 15s–180s). Lower slightly for faster question surfacing. |

**Ordering**: Notes returned by `GET /api/meetings/.../notes` are grouped by section; within a section, bullets sort by **importance_score** (desc), then **t_ms** (desc).

### Assistant feed dedupe (surface)

During meetings, the transcription worker periodically enqueues `meeting_assistant_surface_dedupe`, which batch-embeds recent `claim_verification` and `contradiction` card bodies and **soft-hides** near-duplicate older rows by setting `source_map.ui_suppressed: true` and `source_map.dedupe_of_event_id` on the duplicate. The host/guest events API **omits** `ui_suppressed` cards so the feed shows one story per cluster; rows stay in the database for audit.

| Variable | Effect |
|----------|--------|
| `LIVE_ASSISTANT_SURFACE_DEDUPE_SIM` | Cosine similarity threshold for treating two card bodies as duplicates (default **0.91**, clamped ~0.84–0.99). Raise slightly if you see false collapses. |
| `LIVE_ASSISTANT_BG_JOB_DIRECT` | When true (default **on** outside production for the live worker), the worker also runs in-process **fact-key dedupe** and **surface dedupe** so cards collapse even if the `deal_intel` background worker is not draining the queue. |

### Tracked questions and superseded claims

`meeting_claim` rows that were **corrected in-meeting** get `superseded_by_claim_id` on the old row. Listings for **notes**, **similar-deal style hints**, and **assumption extract** intentionally include only **current** (non-superseded) claims so the model does not re-assert stale numbers. **Q&A detection** (which claim answers which tracked question) still resolves via `buildClaimContext` using the **specific claim id** being verified and matcher rows (`meeting_question_claim_match`), not those filtered lists—so supersession filters should not block marking a question answered when the active replacement claim is linked correctly.

## Research Planner MVP

### Where it lives

- Open a company page at `/home/deal-intel/<dealId>`.
- Click **Research planner** to open `/home/deal-intel/<dealId>/research`.

### Expected workflow

1. Click **Generate plan** to create website/task steps for the selected company.
2. Drag steps to reorder, edit website/task fields, add/delete steps.
3. Click **Save edits** to persist changes (versioned update).
4. Click **Run ready steps** (or run an individual step) to execute public-web research.
5. Review **Evidence** and **Suggested plan updates**, then accept/reject suggestions.

### Common issues

- **Generate plan fails**:
  - Verify Gemini env vars are present (`GEMINI_MODEL_FLASH*`) and restart `npm run dev`.
  - Ensure the selected deal exists and is owned by the signed-in user.
- **Execution returns weak/no sources**:
  - MVP uses public-web grounding only; some tasks require inaccessible/private sources.
  - Reword the step task to be specific and evidence-oriented.
- **Version conflict on save**:
  - Another tab/session modified the workflow. Refresh and apply your changes again.
- **No workflow appears after generation**:
  - Confirm migration `035_deal_intel_research_workflow.sql` has been applied in your Supabase environment.
