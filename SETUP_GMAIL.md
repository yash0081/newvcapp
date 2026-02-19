# Gmail Integration Setup

## 1. Create Google OAuth Client

### Step 1: Create or Select a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your project ID (you'll need it for Pub/Sub later)

### Step 2: Enable Gmail API

1. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for "Gmail API"
3. Click on it and press "Enable"

### Step 3: Create OAuth Consent Screen

1. Go to [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Choose "External" (unless you have a Google Workspace account)
3. Fill in required fields:
   - App name: Your app name
   - User support email: Your email
   - Developer contact information: Your email
4. Click "Save and Continue"
5. Add scopes (if prompted):
   - `https://www.googleapis.com/auth/gmail.readonly`
6. Add test users (for development) or publish the app
7. Click "Save and Continue" through the rest

### Step 4: Create OAuth 2.0 Client ID

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" → "OAuth client ID"
3. Choose "Web application"
4. Name it (e.g., "Gmail Integration Client")
5. Add Authorized redirect URIs:
   - For local development: `http://localhost:3000/api/gmail/callback`
   - For production: `https://yourdomain.com/api/gmail/callback`
6. Click "Create"
7. Copy the **Client ID** and **Client Secret**
8. Add them to your `.env` file:
   ```env
   GOOGLE_CLIENT_ID=your-client-id-here
   GOOGLE_CLIENT_SECRET=your-client-secret-here
   ```

## 2. Run the database migration

In Supabase Dashboard → SQL Editor, run the contents of `supabase/migrations/001_gmail_schema.sql`.

## 3. Set up Google Cloud Pub/Sub (for push notifications)

### Create a Pub/Sub Topic

1. Go to [Google Cloud Console → Pub/Sub Topics](https://console.cloud.google.com/cloudpubsub/topic/list)
2. Click "Create Topic"
3. Name it (e.g., `gmail-push`)
4. Note the full topic name: `projects/{project-id}/topics/{topic-name}`

### Create a Push Subscription

You need at least one push subscription so Google can notify your app when new mail arrives.

**For production (Vercel):**

1. Go to [Google Cloud Console → Pub/Sub → Subscriptions](https://console.cloud.google.com/cloudpubsub/subscription/list)
2. Click **Create Subscription**
3. **Subscription ID**: e.g. `gmail-webhook-production`
4. **Topic**: select the same topic you use for `GMAIL_PUBSUB_TOPIC` (e.g. `gmail-push`)
5. **Delivery type**: Push
6. **Endpoint URL**: your **production** webhook URL, e.g.  
   `https://<your-vercel-app>.vercel.app/api/gmail/webhook`  
   (Replace `<your-vercel-app>` with your actual Vercel project URL.)
7. Leave other defaults, then click **Create**

**For local development:** create a second subscription with endpoint `https://<your-ngrok-url>/api/gmail/webhook`, or use a separate topic for local.

**Checklist for automatic emails on Vercel:**

- [ ] Push subscription endpoint is **exactly** your Vercel URL + `/api/gmail/webhook` (HTTPS, no trailing slash)
- [ ] `GMAIL_PUBSUB_TOPIC` is set in Vercel env vars (e.g. `projects/your-project-id/topics/gmail-push`)
- [ ] User connected Gmail **from the deployed app** (so the watch was registered with Google for that topic)

### Grant Gmail API permissions

1. Go to [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Find or create a service account for Pub/Sub
3. Grant it the "Pub/Sub Publisher" role
4. In [Gmail API settings](https://console.cloud.google.com/apis/api/gmail.googleapis.com/), ensure Pub/Sub is enabled

## 4. Environment variables

Add to your `.env`:

```env
# Supabase
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
# Get from: Supabase Dashboard → Project Settings → API → service_role (secret)

# Google OAuth (already configured)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Gmail Integration
GOOGLE_GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/callback
# For production: https://yourdomain.com/api/gmail/callback

# Pub/Sub Topic (from step 2)
GMAIL_PUBSUB_TOPIC=projects/your-project-id/topics/your-topic-name
```

## 5. How it works

- **Initial Connection**: When a user connects Gmail, the app:
  1. Sets up a Gmail watch subscription (push notifications)
  2. Fetches initial emails automatically
  3. Stores them in the database

- **Background Updates**: New emails trigger webhooks to `/api/gmail/webhook`, which:
  1. Receives the push notification from Google Pub/Sub
  2. Fetches new emails since the last historyId
  3. Updates the database automatically

- **Manual Sync**: Users can click "Sync now" to manually fetch new emails

- **Disconnection**: Use the "Disconnect Gmail" button to:
  1. Stop the Gmail watch subscription
  2. Delete the connection from the database
  3. Clean up all related data

## 6. Troubleshooting

- **Webhooks not working**: Verify the Pub/Sub subscription endpoint URL is correct and accessible
- **No emails appearing**: Check that the watch subscription was created successfully (check `watch_expiration` in database)
- **Login breaks after deleting connection**: This is now fixed - the app handles missing connections gracefully

### Automatic (background) emails not working on Vercel

"Sync now" works without the topic or webhook; it only uses tokens and `history_id`. Push uses the topic + subscription. If push is set up but new mail still doesn’t appear automatically:

1. **Reconnect Gmail from the deployed app**  
   Open your **Vercel** app URL, disconnect Gmail, then connect again. That re-registers the Gmail watch. Watches expire in about 7 days, so if you connected a while ago (or only ever from localhost), the watch may have expired.

2. **Check whether the webhook is being called**  
   In Vercel → Project → Logs (or Runtime Logs), filter for `/api/gmail/webhook`. Send yourself a test email and see if a POST appears when the message arrives.  
   - **No request** → Google isn’t reaching your app. Check: Pub/Sub subscription endpoint is exactly `https://<your-vercel-domain>/api/gmail/webhook`; subscription is on the same topic as `GMAIL_PUBSUB_TOPIC`; push delivery is enabled. If the subscription uses authentication, ensure it’s set up so Google can call your endpoint (e.g. allow unauthenticated push if you’re not using OIDC).

3. **Requests appear but emails don’t update**  
   Check the same logs for errors (4xx/5xx or stack traces). Fix any auth or runtime errors in the webhook so it returns 200 and completes successfully.
