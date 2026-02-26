# PDF pitch detection and scoring – full plan

## Overview

Detect emails that contain a single PDF attachment within a **file-size limit** (pitch-deck-sized, ~10–15 slides), run a **7-step prompt pipeline** (PDF → extraction, then JSON + web → scores), store results, and show **ranked pitch decks** in the email tab. No PDF text extraction: the PDF is sent directly to Gemini. Composite rank uses four quality scores; investment-based weighting is deferred.

**Build scope (current):** Implement the full PDF pitch prompt and scoring infrastructure. App output stays the same except the main view shows **scored pitches in card format** with an **aggregated description** (commentaries from the output JSONs, separated by paragraph); other emails remain as the current list.

---

## 1. Gmail: full message and PDF attachment

**Where:** [lib/gmail.ts](lib/gmail.ts) and optionally a small `lib/gmail-attachments.ts`.

- **Full message:** `client.users.messages.get` with `format: "full"`. Parse `payload.parts` (including nested `parts`) for `mimeType === "application/pdf"`, `filename` ending in `.pdf`, and `body.attachmentId`.
- **Attachment bytes:** For given `messageId` and `attachmentId`, call `client.users.messages.attachments.get`. Decode returned base64url `data` to a `Buffer` for downstream use.
- **When:** Only in the dedicated “process this email for PDF” flow (not in sync/webhook). Gmail scope remains `gmail.readonly`.

---

## 2. PDF file size (no page count, no text extraction)

**Where:** In the process flow, after fetching the attachment buffer (no separate PDF library needed).

- **Rule:** Qualify only if the PDF’s **byte size** is within a configured max. A typical 10–15 slide pitch deck (with images) is often **~1–10 MB**. Use a **max size (e.g. 10 MB)** to include normal decks and exclude huge documents; tune via env (e.g. `PITCH_DECK_PDF_MAX_BYTES`).
- **Check:** `buffer.length <= PITCH_DECK_PDF_MAX_BYTES` (and optionally a min size to skip tiny/empty files, e.g. 50 KB).
- If an email has multiple PDFs, use the first that qualifies (or define a rule, e.g. largest under the limit).
- **No** page counting and **no** text extraction; the PDF is sent as-is to Gemini for PDF-based prompts.

---

## 3. Database: extraction outputs and scores

**Where:** New migration, e.g. `supabase/migrations/003_pitch_deck_pipeline.sql`.

**Table:** `pitch_deck_results` (or `email_pdf_scores`).

- `id` UUID PK  
- `email_id` UUID FK → `emails.id` UNIQUE (one deck per email)  
- `gmail_message_id` TEXT  
- `gmail_attachment_id` TEXT  
- `pdf_size_bytes` INT (optional; for debugging / display)  

**Intermediate outputs (for pipeline and debugging):**

- `parsing_json` JSONB — output of Step 1 (founder/team + metrics extraction)  
- `problem_extraction_json` JSONB — output of Step 2  
- `solution_extraction_json` JSONB — output of Step 3  

**Scores (for ranking and composite):**

- `problem_quality_score` NUMERIC — from Step 4  
- `solution_quality_score` NUMERIC — from Step 5  
- `founder_team_quality_score` NUMERIC — from Step 6  
- `metrics_quality_score` NUMERIC — from Step 7  
- `composite_score` NUMERIC — function of the four scores (e.g. weighted average; weights TBD / later investment-based)  

**Web step outputs (for UI commentary aggregation):**

- `problem_web_json` JSONB — full Step 4 output (includes `problem_quality_commentary`, `uncertainty_commentary`)  
- `solution_web_json` JSONB — full Step 5 output (includes `solution_quality_commentary`, `uncertainty_commentary`)  
- `founder_web_json` JSONB — full Step 6 output (includes `founder_team_quality_commentary`)  
- `metrics_web_json` JSONB — full Step 7 output (includes `metrics_quality_commentary`)  

**Metadata:**

- `processed_at` TIMESTAMPTZ  

RLS: restrict to the user who owns the email (via `emails.gmail_connection_id` → `gmail_connections.user_id`). Indexes: `email_id`, `composite_score DESC` for ranked listing.

**Later (out of scope):** “Top X invested” / “Top X recent” and weight updates will drive how `composite_score` is computed; schema can stay, only scoring/weighting logic changes.

---

## 4. Seven-step prompt pipeline

Prompt text and output schemas are defined in [PDF Prompts.md](../PDF%20Prompts.md). Below is the pipeline shape and how it affects implementation.

### 4.1 PDF-in, JSON-out (no text extraction)

**Step 1 – PDF parsing (founder + team combined)**  
- **Input:** PDF (send bytes as multimodal input to Gemini).  
- **Output:** Strict JSON: `team_members[]`, `metrics`. Extraction only; no inference, no scoring.  
- **Implementation:** One Gemini call with PDF + prompt from PDF Prompts; parse and validate JSON; store in `parsing_json`.

**Step 2 – Problem PDF extraction**  
- **Input:** Same PDF.  
- **Output:** Strict JSON: `summary_problem`, `target_customer`, `pain_points`, `quantified_problem_claims`, `extraction_confidence`, `failure_mode`.  
- **Implementation:** One Gemini call with PDF + Problem PDF prompt; store in `problem_extraction_json`.

**Step 3 – Solution PDF extraction**  
- **Input:** Same PDF.  
- **Output:** Strict JSON: `summary_solution`, `product_type`, `core_features`, `claimed_differentiation`, `claimed_defensibility`, `extraction_confidence`, `failure_mode`.  
- **Implementation:** One Gemini call with PDF + Solution PDF prompt; store in `solution_extraction_json`.

Steps 2 and 3 can be run in parallel after the PDF is fetched; Step 1 can be run in parallel with 2 and 3 if desired.

### 4.2 JSON-in + web, scores out (wire outputs → inputs)

We take the **specific output JSON** from each step and pass it as the **input** to the step that requires it. No mixing: each web step gets exactly the JSON produced by its designated predecessor.

| Step | Input (from previous output) | Output (scores / JSON we persist) |
|------|------------------------------|------------------------------------|
| **4 – Problem web** | Full JSON from **Step 2** (`problem_extraction_json`) | `problem_quality_score`, etc. |
| **5 – Solution web** | Full JSON from **Step 3** (`solution_extraction_json`) | `solution_quality_score`, etc. |
| **6 – Founder and team** | Full JSON from **Step 1** (`parsing_json`) | `founder_team_quality_score`, etc. |
| **7 – Metrics** | Full JSON from **Step 1** (`parsing_json`) | `metrics_quality_score`, etc. |

**Step 4 – Problem web search**  
- **Input:** The full output of Step 2 — `problem_extraction_json` (summary_problem, target_customer, pain_points, quantified_problem_claims, extraction_confidence, failure_mode).  
- **Output:** Strict JSON including `problem_quality_score`, `verification_confidence`, `uncertainty_score`, commentaries, `sources`.  
- **Implementation:** Gemini with **external web sources**. Pass Step 2’s JSON as the input context; parse response; persist `problem_quality_score`.

**Step 5 – Solution web**  
- **Input:** The full output of Step 3 — `solution_extraction_json` (summary_solution, product_type, core_features, claimed_differentiation, claimed_defensibility, extraction_confidence, failure_mode).  
- **Output:** Strict JSON including `solution_quality_score`, verification, uncertainty, sources.  
- **Implementation:** Same pattern; pass Step 3’s JSON; persist `solution_quality_score`.

**Step 6 – Founder and team (web)**  
- **Input:** The full output of Step 1 — `parsing_json` (team_members, metrics).  
- **Output:** Strict JSON including `founder_team_quality_score`, verification, risk, etc.  
- **Implementation:** Web-backed call with Step 1’s JSON as input; persist `founder_team_quality_score`.

**Step 7 – Metrics (web)**  
- **Input:** The full output of Step 1 — `parsing_json` (team_members, metrics).  
- **Output:** Strict JSON including `metrics_quality_score`, verification, financial risk, etc.  
- **Implementation:** Web-backed call with Step 1’s JSON as input; persist `metrics_quality_score`.

**Composite score:** Compute `composite_score` from the four scores (e.g. equal or weighted average). Weights can later incorporate investment (top invested, recency, etc.).

**Strict JSON:** Every prompt requires “strict JSON only”. Implementation must request JSON in the prompt and parse/validate the model response; handle malformed or non-JSON responses (retry or mark as failed).

---

## 5. Gemini and web-backed calls

**Where:** e.g. `lib/gemini.ts` (or `lib/pipeline.ts`).

### 5.1 Model assignment

Use two models so the heavier reasoning runs on the stronger model and the rest on a faster one:

| Steps | Model | Rationale |
|-------|--------|------------|
| **4 – Problem web**, **5 – Solution web** | **Gemini 3** (or top-tier when available, e.g. Pro) | Web search + synthesis, quality/uncertainty scoring, and commentary; benefit from stronger reasoning. |
| **1 – PDF parsing**, **2 – Problem PDF**, **3 – Solution PDF**, **6 – Founder/team web**, **7 – Metrics web** | **Gemini 2.5 Flash** | Structured extraction (1–3) and factual lookup + scoring (6–7); Flash is sufficient and cheaper/faster. |

- **Config:** Env vars e.g. `GEMINI_API_KEY`, `GEMINI_MODEL_WEB_HEAVY` (for steps 4–5), `GEMINI_MODEL_FLASH` (for steps 1–3, 6–7). Map “Gemini 3” / “Gemini 2.5 Flash” to the actual API model IDs when implementing.  
- **PDF input:** For Steps 1–3, send the PDF as inline multimodal input (e.g. `inlineData: { mimeType: "application/pdf", data: base64 }`). No text extraction.  
- **Web-backed steps (4–7):** Use a Gemini configuration that enables “external web sources” (e.g. Google Search grounding), or integrate a separate search API and pass context into the model. Plan explicitly depends on having this capability for steps 4–7.  
- **Idempotency:** If a row exists for `email_id`, either skip or re-run and overwrite (re-run is simpler for “re-score” later).

---

## 6. Processing trigger

**Where:** e.g. `app/api/gmail/process-pitch-decks/route.ts` (POST).

- **Auth:** Same as sync (signed-in user, their Gmail connection).  
- **Flow:**  
  1. Load emails from DB for this connection (e.g. recent N or all non-deleted).  
  2. For each email: get full message from Gmail, find PDF parts, get attachment buffer, check file size (e.g. ≤ 10 MB). If none qualify, skip.  
  3. If qualifying PDF and (no existing row or re-run):  
     - Run Steps 1–3 (PDF → parsing + problem + solution JSON).  
     - Run Steps 4–7 (JSON + web → four scores).  
     - Compute `composite_score`; upsert into `pitch_deck_results`.  
- **Trigger:** “Score pitch decks” (or “Process PDFs”) button on home, or cron (e.g. Vercel Cron). Do not run inside sync/webhook to avoid timeouts.

Optional later: lightweight “is pitch?” pre-filter (e.g. Gemma on email body snippet) before step 2.

---

## 7. Home tab: scored pitches (cards) + other emails

**Where:** [app/home/page.tsx](app/home/page.tsx).

App behavior stays the same (connect, disconnect, sync, delete). The main content change: **display scored pitches** instead of only a plain email list. Scored pitches use a **card-style** layout; other emails stay as the current list.

### 7.1 Data

- Query `emails` as today; join `pitch_deck_results` (and `problem_web_json`, `solution_web_json`, `founder_web_json`, `metrics_web_json`) so each scored pitch has scores and web outputs for commentary.  
- **Ranked pitch decks:** Rows in `pitch_deck_results`, ordered by `composite_score` DESC (then `processed_at` or email date).  
- **Other emails:** Emails with no `pitch_deck_results` row, sorted by date (current list behavior).

### 7.2 Card-style UI for scored pitches

Each scored pitch is shown as a **card**:

- **Card contents:**  
  - **Header:** Subject (or “No subject”), from, date.  
  - **Score:** Composite score (and optionally the four scores: problem, solution, founder/team, metrics).  
  - **Description:** Aggregated commentary from the pipeline output JSONs (see 7.3).  
  - **Actions:** Same as today where applicable (e.g. delete email / pitch deck).  

- **Layout:** Cards in a responsive grid or list of cards (e.g. `grid` or stacked cards with clear separation). Use existing design system (e.g. [components/ui/card.tsx](components/ui/card.tsx) if present) for consistency.

### 7.3 Commentary aggregation (description)

Build a single **description** for each card by aggregating commentary fields from the web step outputs. Use the **exact** commentary strings from the JSON; separate logical groups into **paragraphs** (e.g. one paragraph per step or per theme). Order:

1. **Problem** — From `problem_web_json`: `problem_quality_commentary`, then `uncertainty_commentary` (if present). Each non-null value = one paragraph or sentence block.  
2. **Solution** — From `solution_web_json`: `solution_quality_commentary`, then `uncertainty_commentary`.  
3. **Founder / team** — From `founder_web_json`: `founder_team_quality_commentary`.  
4. **Metrics** — From `metrics_web_json`: `metrics_quality_commentary`.  

Implementation: server or client reads the four JSONB columns, extracts the fields above, filters null/empty, and joins with paragraph breaks (e.g. `\n\n` or separate `<p>` in the UI). Result is a **description** shown in the card body.

### 7.4 Rest of the app

- **Other emails:** Shown below (or in a separate section) as the current list (subject, from, date, snippet, delete). No change to connect Gmail, disconnect, sync, delete-email behavior.  
- **Refresh:** Existing 3-minute refresh continues so new scores and cards appear without reload.

---

## 8. Dependencies and env

- **Deps:** Gemini SDK (e.g. `@google/generative-ai`). No PDF library needed for size (use `buffer.length`).  
- **Env:** [.env.example](.env.example): `GEMINI_API_KEY`, `GEMINI_MODEL_WEB_HEAVY` (steps 4–5, e.g. Gemini 3), `GEMINI_MODEL_FLASH` (steps 1–3, 6–7, e.g. Gemini 2.5 Flash), and `PITCH_DECK_PDF_MAX_BYTES` (e.g. `10485760` for 10 MB). No Gmail scope change.

---

## 9. Out of scope (for later)

- “Is this a pitch?” classifier (e.g. Gemma on email body).  
- Weighting scores by investment amount.  
- “Top X most invested” ordered set and “top X most recent” queue and their storage/updates.

---

## 10. Implementation order (suggested)

1. Migration: `pitch_deck_results` table and RLS.  
2. Gmail: full message + list PDF parts + fetch attachment by ID.  
3. Qualify by PDF file size (e.g. `buffer.length <= PITCH_DECK_PDF_MAX_BYTES`).  
4. Gemini: send PDF for Step 1; parse JSON; then add Steps 2–3; wire Step 1 output → Steps 6 and 7 input, Step 2 output → Step 4 input, Step 3 output → Step 5 input.  
5. Gemini + web: implement Steps 4–7; persist four scores, `composite_score`, and web step JSONs (`problem_web_json`, `solution_web_json`, `founder_web_json`, `metrics_web_json`) for commentary.  
6. API route: process-pitch-decks (loop emails → PDF check → run pipeline → save).  
7. Home UI: query results; **Ranked pitch decks** as **cards** (subject, from, date, score, description = aggregated commentary); aggregate commentaries from web JSONs by paragraph (Problem → Solution → Team → Metrics). **Other emails** as current list below.  
8. Button: “Score pitch decks”; optionally wire cron.  
9. .env.example and README/SETUP note for Gemini and (if used) web/search.

---

## Summary

- **No PDF text parsing:** PDF is sent directly to Gemini for Steps 1–3.  
- **Pipeline:** 1 (PDF → parsing JSON) → 2–3 (PDF → problem/solution JSON, parallel ok) → 4–7 (each web step takes the **correct** prior output JSON as input); composite from the four scores. **Qualify PDFs by file size** (e.g. max 10 MB), not page count.  
- **Ranking:** By `composite_score`; later adjustable by investment and top-invested/top-recent logic.  
- **Prompt text and schemas:** As in [PDF Prompts.md](../PDF%20Prompts.md).  
- **Models:** Problem web + Solution web → Gemini 3 (or Pro); all other steps → Gemini 2.5 Flash.  
- **UI:** Scored pitches in **card-style** layout; description = **aggregated commentary** from web step JSONs, separated by paragraph (Problem, Solution, Founder/team, Metrics). Other emails unchanged.
