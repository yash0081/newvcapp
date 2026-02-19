"use client";

import { createClient } from "@/lib/supabase/client";

export function GoogleSignInButton() {
  const signInWithGoogle = async () => {
    const supabase = createClient();

    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <button
      onClick={signInWithGoogle}
      className="rounded-full border-2 border-blue-600 bg-white text-blue-600 text-lg px-8 py-5 font-bold hover:bg-blue-50 active:scale-95 transition-all duration-200 shadow-sm hover:shadow-md w-full max-w-[320px]"
    >
      Sign in with Google
    </button>
  );
}
