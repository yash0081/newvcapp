import { GoogleSignInButton } from "@/components/google-sign-in-button";

export default function Home() {
  return (
    <main className="min-h-screen bg-white flex flex-col items-center justify-center">
      <GoogleSignInButton />
    </main>
  );
}
