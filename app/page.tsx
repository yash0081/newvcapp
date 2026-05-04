import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { UsernamePasswordAuth } from "@/components/auth/username-password-auth";

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-6">
        <header className="flex items-center justify-between">
          <div className="inline-flex h-11 items-center rounded-full border border-zinc-200 bg-white px-4 text-sm font-semibold shadow-sm">
            Investora Labs
          </div>
          <p className="hidden text-sm font-medium text-zinc-500 sm:block">Investment workflow automation</p>
        </header>

        <section className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="max-w-2xl">
            <p className="mb-4 inline-flex rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Private deal workspace
            </p>
            <h1 className="text-5xl font-semibold tracking-tight text-zinc-950 sm:text-6xl">
              Automating the investment workflow
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-zinc-600">
              Research companies, compare opportunities, generate documents, and keep diligence evidence organized in one focused workspace.
            </p>
          </div>

          <div className="mx-auto w-full max-w-md rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-[0_24px_80px_rgba(24,24,27,0.10)]">
            <div className="rounded-[1.5rem] border border-zinc-200 bg-zinc-50 p-5">
              <p className="text-sm font-semibold text-zinc-950">Sign in</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                Continue to your investment workspace.
              </p>
              <div className="mt-6">
                <UsernamePasswordAuth />
              </div>
              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-zinc-200" />
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">or</span>
                <div className="h-px flex-1 bg-zinc-200" />
              </div>
              <div>
                <GoogleSignInButton />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
