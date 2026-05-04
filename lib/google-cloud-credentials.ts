import { writeFileSync } from "node:fs";
import { join } from "node:path";

let initialized = false;

export function ensureGoogleCloudCredentialsFile() {
  if (initialized || process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return;

  const filePath = join("/tmp", "google-application-credentials.json");
  writeFileSync(filePath, raw, { encoding: "utf8", mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  initialized = true;
}
