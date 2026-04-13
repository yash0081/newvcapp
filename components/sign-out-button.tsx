"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      className={
        className ??
        "mt-4 px-6 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
      }
    >
      Sign out
    </button>
  );
}
