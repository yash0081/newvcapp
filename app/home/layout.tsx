import { Suspense, type ReactNode } from "react";
import { HomeAppShell } from "@/components/home-app-shell";

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <HomeAppShell>
        <Suspense>{children}</Suspense>
      </HomeAppShell>
    </Suspense>
  );
}
