import { HomeAppShell } from "@/components/home-app-shell";

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <HomeAppShell>{children}</HomeAppShell>;
}
