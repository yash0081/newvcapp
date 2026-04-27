-- Add deleted_at column for soft deletes
ALTER TABLE emails ADD COLUMN deleted_at TIMESTAMPTZ;

-- Add RLS policy for deleting emails
CREATE POLICY "Users can delete own emails"
  ON emails FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM gmail_connections gc
      WHERE gc.id = gmail_connection_id AND gc.user_id = auth.uid()
    )
  );

-- Update the SELECT policy to exclude deleted emails
DROP POLICY IF EXISTS "Users can view own emails" ON emails;
CREATE POLICY "Users can view own emails"
  ON emails FOR SELECT
  USING (
    deleted_at IS NULL AND
    EXISTS (
      SELECT 1 FROM gmail_connections gc
      WHERE gc.id = gmail_connection_id AND gc.user_id = auth.uid()
    )
  );

-- Index for filtering deleted emails
CREATE INDEX emails_deleted_at_idx ON emails(deleted_at) WHERE deleted_at IS NULL;
