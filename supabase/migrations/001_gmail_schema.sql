-- Gmail connections: one per user per connected Gmail
CREATE TABLE gmail_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  watch_expiration TIMESTAMPTZ,
  history_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Emails: email metadata
CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_connection_id UUID NOT NULL REFERENCES gmail_connections(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  subject TEXT,
  from_address TEXT,
  date TIMESTAMPTZ,
  snippet TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(gmail_connection_id, gmail_message_id)
);

-- RLS policies: users can only access their own data
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;

-- gmail_connections: users can CRUD their own
CREATE POLICY "Users can view own gmail_connections"
  ON gmail_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own gmail_connections"
  ON gmail_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own gmail_connections"
  ON gmail_connections FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own gmail_connections"
  ON gmail_connections FOR DELETE
  USING (auth.uid() = user_id);

-- emails: users can view/insert via their connection
CREATE POLICY "Users can view own emails"
  ON emails FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM gmail_connections gc
      WHERE gc.id = gmail_connection_id AND gc.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own emails"
  ON emails FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM gmail_connections gc
      WHERE gc.id = gmail_connection_id AND gc.user_id = auth.uid()
    )
  );

-- Index for webhook lookup by email
CREATE INDEX gmail_connections_email_idx ON gmail_connections(email);
