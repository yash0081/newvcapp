import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";

// FLASH_MODEL: cheaper/faster model for PDF + lighter web steps
// WEB_HEAVY_MODEL: stronger model for problem/solution web steps
//
// Default model IDs come from Google’s Gemini API docs.
// - Gemini 2.5 Flash Lite: "gemini-2.5-flash-lite"
// - Gemini 3 Flash (preview): "gemini-3-flash-preview"
const FLASH_LITE = process.env.GEMINI_MODEL_FLASH_LITE ?? process.env.GEMINI_MODEL_FLASH ?? "gemini-2.5-flash-lite";
const FLASH_MODEL = process.env.GEMINI_MODEL_FLASH ?? "gemini-2.5-flash";
const WEB_HEAVY_MODEL = process.env.GEMINI_MODEL_WEB_HEAVY ?? "gemini-3-flash-preview";

export type ModelTier = "flash_lite" | "flash" | "heavy";

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(key);
}

function getModel(name: string): GenerativeModel {
  return getClient().getGenerativeModel({ model: name });
}

export function getModelByTier(tier: ModelTier): GenerativeModel {
  const name = tier === "flash_lite" ? FLASH_LITE : tier === "flash" ? FLASH_MODEL : WEB_HEAVY_MODEL;
  return getModel(name);
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
 * @param modelTier "flash_lite" | "flash" | "heavy"
 */
export async function runWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  const model = getModelByTier(modelTier);
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
 * Run Gemini with text/JSON input only. Returns parsed JSON.
 * @param modelTier "flash_lite" | "flash" | "heavy"
 */
export async function runWithText(
  prompt: string,
  inputJson: unknown,
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  const model = getModelByTier(modelTier);
  const inputStr = typeof inputJson === "string" ? inputJson : JSON.stringify(inputJson, null, 2);
  const fullPrompt = `Input JSON from previous step:\n${inputStr}\n\n${prompt}\n\nReturn strict JSON only, no other text.`;
  const result = await model.generateContent(fullPrompt);
  const response = result.response;
  const text = response.text();
  if (!text) throw new Error("Empty Gemini response");
  return parseJsonFromResponse(text);
}

/** Run with multiple text inputs (e.g. thesis + JSON). */
export async function runWithTextMulti(
  prompt: string,
  inputs: { label: string; value: unknown }[],
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  const model = getModelByTier(modelTier);
  const parts = inputs
    .map(({ label, value }) => {
      const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `${label}:\n${str}`;
    })
    .join("\n\n");
  const fullPrompt = `${parts}\n\n---\n\n${prompt}\n\nReturn strict JSON only, no other text.`;
  const result = await model.generateContent(fullPrompt);
  const response = result.response;
  const text = response.text();
  if (!text) throw new Error("Empty Gemini response");
  return parseJsonFromResponse(text);
}
