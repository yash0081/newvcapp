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
