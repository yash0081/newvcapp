import { NextResponse } from "next/server";
import { usernameToAuthEmail, validateUsername } from "@/lib/auth/username";
import { createAdminClient } from "@/lib/supabase/admin";

type SignupBody = {
  username?: unknown;
  password?: unknown;
};

const SIGNUP_WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_MAX_ATTEMPTS = 8;
const signupAttempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request, username: string): string {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  return `${forwardedFor || realIp || "unknown"}:${username.trim().toLowerCase()}`;
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const current = signupAttempts.get(key);
  if (!current || current.resetAt <= now) {
    signupAttempts.set(key, { count: 1, resetAt: now + SIGNUP_WINDOW_MS });
    return false;
  }
  current.count += 1;
  signupAttempts.set(key, current);
  return current.count > SIGNUP_MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as SignupBody | null;
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const usernameError = validateUsername(username);
  if (usernameError) return NextResponse.json({ error: usernameError }, { status: 400 });
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  if (isRateLimited(clientKey(req, username))) {
    return NextResponse.json({ error: "Too many signup attempts. Please try again later." }, { status: 429 });
  }

  const admin = createAdminClient();
  const email = usernameToAuthEmail(username);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username: username.trim().toLowerCase(),
      auth_method: "username_password",
    },
  });

  if (error) {
    const duplicate = /already|exists|registered/i.test(error.message);
    return NextResponse.json(
      { error: duplicate ? "That username is already taken." : error.message },
      { status: duplicate ? 409 : 400 },
    );
  }

  return NextResponse.json({ userId: data.user?.id ?? null });
}
