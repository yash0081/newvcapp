"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usernameToAuthEmail, validateUsername } from "@/lib/auth/username";
import { createClient } from "@/lib/supabase/client";

type Mode = "sign-in" | "sign-up";

export function UsernamePasswordAuth() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setMessage(null);
    const usernameError = validateUsername(username);
    if (usernameError) {
      setMessage(usernameError);
      return;
    }
    if (password.length < 8) {
      setMessage("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "sign-up") {
        const res = await fetch("/api/auth/password-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(data?.error || "Could not create account.");
      }

      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: usernameToAuthEmail(username),
        password,
      });
      if (error) throw error;
      router.push("/home/deals");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-full bg-zinc-100 p-1">
        {(["sign-in", "sign-up"] as Mode[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => {
              setMode(item);
              setMessage(null);
            }}
            className={`h-9 rounded-full text-sm font-semibold transition ${
              mode === item ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {item === "sign-in" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="crm-input h-11"
            placeholder="username"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            className="crm-input h-11"
            placeholder="At least 8 characters"
            type="password"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
      </div>

      {message ? <p className="text-sm font-medium text-red-600">{message}</p> : null}

      <button type="button" onClick={submit} disabled={busy} className="crm-button h-11 w-full">
        {busy ? "Working..." : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
    </div>
  );
}
