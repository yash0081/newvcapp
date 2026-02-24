import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";

// FLASH_MODEL: cheaper/faster model for PDF + lighter web steps
// WEB_HEAVY_MODEL: stronger model for problem/solution web steps
//
// Default model IDs come from Google’s Gemini API docs.
// - Gemini 2.5 Flash Lite: "gemini-2.5-flash-lite"
// - Gemini 3 Flash (preview): "gemini-3-flash-preview"
const FLASH_MODEL = process.env.GEMINI_MODEL_FLASH ?? "gemini-2.5-flash-lite";
const WEB_HEAVY_MODEL = process.env.GEMINI_MODEL_WEB_HEAVY ?? "gemini-3-flash-preview";

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(key);
}

function getModel(name: string): GenerativeModel {
  return getClient().getGenerativeModel({ model: name });
}

/**
 * Extract JSON from model response (handles optional markdown code blocks).
 */
export function parseJsonFromResponse(text: string): unknown {
  const trimmed = text.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```$/;
  const match = trimmed.match(codeBlock);
  const jsonStr = match ? match[1].trim() : trimmed;
  return JSON.parse(jsonStr) as unknown;
}

/**
 * Run Gemini with PDF inline. Returns parsed JSON.
 */
export async function runWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
  useHeavyModel: boolean = false
): Promise<unknown> {
  const model = getModel(useHeavyModel ? WEB_HEAVY_MODEL : FLASH_MODEL);
  const base64 = pdfBuffer.toString("base64");
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "application/pdf",
        data: base64,
      },
    },
    { text: prompt + "\n\nReturn strict JSON only, no other text." },
  ]);
  const response = result.response;
  const text = response.text();
  if (!text) throw new Error("Empty Gemini response");
  return parseJsonFromResponse(text);
}

/**
 * Run Gemini with text/JSON input only (for web steps). Returns parsed JSON.
 */
export async function runWithText(
  prompt: string,
  inputJson: unknown,
  useHeavyModel: boolean = false
): Promise<unknown> {
  const model = getModel(useHeavyModel ? WEB_HEAVY_MODEL : FLASH_MODEL);
  const inputStr = typeof inputJson === "string" ? inputJson : JSON.stringify(inputJson, null, 2);
  const fullPrompt = `Input JSON from previous step:\n${inputStr}\n\n${prompt}\n\nReturn strict JSON only, no other text.`;
  const result = await model.generateContent(fullPrompt);
  const response = result.response;
  const text = response.text();
  if (!text) throw new Error("Empty Gemini response");
  return parseJsonFromResponse(text);
}
