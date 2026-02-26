# Plan update: PDF → Gemini directly (no text extraction for prompts)

**Change:** Use the PDF file itself as input to the Gemini API for the main scoring prompts instead of extracting text first.

## What changes from the original plan

1. **Gemini input for scoring prompts**
   - Send the **PDF bytes** (or a base64/data URL of the PDF) to Gemini as multimodal input.
   - Gemini supports PDF natively (e.g. `@google/generative-ai` with `generateContent` and a part with `inlineData: { mimeType: "application/pdf", data: base64 }`).
   - No need for a separate “extract PDF text” step for the main prompts.

2. **PDF library usage**
   - **Keep** a small PDF library only for **page count** (to enforce 1–15 pages before calling Gemini). Use something like `pdf-parse` or `pdfjs-dist` just to get `pageCount`; no need to extract full text for the scoring pipeline.
   - **Remove** `extractPdfText` (or equivalent) from the scoring flow; the main prompts run on the PDF asset in Gemini.

3. **Flow**
   - Fetch PDF attachment from Gmail → get buffer.
   - Get page count (local lib); if not in 1–15, skip.
   - Send same PDF buffer (e.g. base64) to Gemini for each prompt in the series; Gemini reads the PDF directly and returns scores.

4. **Optional “is pitch?” pre-filter**
   - If you still use a lightweight model (e.g. Gemma) on the **email body** (first N characters), that stays as-is; it doesn’t use the PDF. The PDF is only used for the main Gemini scoring prompts.

## Implementation notes

- In `lib/gemini.ts` (or scoring module): accept `pdfBuffer: Buffer` (or base64 string) and build the Gemini request with the PDF as an inline part; run your prompt series and parse scores from the responses.
- Page-count check remains in `lib/pdf.ts` (or equivalent) using a lightweight PDF parser only for `getPdfPageCount(buffer)`.
