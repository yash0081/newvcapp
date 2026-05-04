# GCP Background Worker

The Vercel app handles UI/API requests and enqueues background work into the Supabase `deal_intel` job queue. This worker consumes that queue by running:

```bash
npm run deal-intel:bg-worker
```

This covers ingestion/enrichment jobs such as document chunk refinement, fact embeddings, keyword graph work, full tree refinement, and copilot session sync. Live meeting transcription is separate and should be productionized later as a per-meeting Cloud Run Job.

## Recommended GCP Runtime

Use a Cloud Run Worker Pool for the queue worker because it is a continuous, non-HTTP, pull-based process. Do not deploy this infinite loop as a normal Cloud Run service unless you also add an HTTP listener and configure service CPU appropriately.

## Build Image

Set these shell variables:

```bash
export PROJECT_ID="your-gcp-project"
export REGION="us-central1"
export REPOSITORY="workroom"
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/workroom-bg-worker:latest"
```

Create the Artifact Registry repository once:

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Workroom containers"
```

Build and push:

```bash
gcloud builds submit \
  --config cloudbuild.worker.yaml \
  --substitutions _IMAGE="$IMAGE"
```

## Deploy Worker Pool

Create a YAML env file locally, not committed to git:

```yaml
NEXT_PUBLIC_SUPABASE_URL: "https://..."
SUPABASE_SERVICE_ROLE_KEY: "..."
GOOGLE_CLOUD_PROJECT: "your-gcp-project"
VERTEX_ENABLE_GOOGLE_SEARCH: "true"
VERTEX_GCS_BUCKET: "..."
VERTEX_EMBEDDING_MODEL: "text-embedding-004"
GEMINI_MODEL_FLASH_LITE: "gemini-2.5-flash-lite"
GEMINI_MODEL_FLASH: "gemini-2.5-flash"
GEMINI_MODEL_FLASH_SUMMARY: "gemini-2.5-flash"
```

If the worker uses a GCP service account with Vertex/Storage permissions, you do not need `GOOGLE_APPLICATION_CREDENTIALS_JSON` inside GCP.

Deploy:

```bash
gcloud beta run worker-pools deploy workroom-bg-worker \
  --image "$IMAGE" \
  --region "$REGION" \
  --scaling 1 \
  --memory 1Gi \
  --cpu 1 \
  --env-vars-file worker.env.yaml
```

## IAM

The worker pool service account needs:

- permission to access Vertex AI
- permission to read/write the configured GCS bucket if `VERTEX_GCS_BUCKET` is used
- no direct database IAM is needed; Supabase access uses `SUPABASE_SERVICE_ROLE_KEY`

For least privilege, create a dedicated service account for the worker pool and grant only the roles it needs.

## Verify

Check logs:

```bash
gcloud beta run worker-pools describe workroom-bg-worker --region "$REGION"
```

Then trigger an upload/ingest flow from the Vercel app. You should see queued jobs move through the Supabase job table and worker logs showing claimed/completed jobs.
