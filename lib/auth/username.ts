const USERNAME_DOMAIN = "workroom.local";

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): string | null {
  const username = normalizeUsername(value);
  if (username.length < 3) return "Username must be at least 3 characters.";
  if (username.length > 32) return "Username must be 32 characters or fewer.";
  if (!/^[a-z0-9_-]+$/.test(username)) {
    return "Use only letters, numbers, underscores, or dashes.";
  }
  return null;
}

export function usernameToAuthEmail(value: string): string {
  return `${normalizeUsername(value)}@${USERNAME_DOMAIN}`;
}
