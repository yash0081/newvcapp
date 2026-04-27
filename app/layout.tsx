import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Investment Deep Research Engine",
  description: "",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Dev convenience: autostart the deal-intel bg worker inside the Node.js server process.
  // This is server-only (layouts are Server Components) so it won't leak Node deps to the browser bundle.
  const { startBgWorkerInProcess } = await import("@/lib/deal-intel/bg-worker");
  // In dev, Next may abort renders; schedule the worker outside the render/abort context to avoid noisy AbortError logs.
  globalThis.setTimeout(() => startBgWorkerInProcess(), 0);

  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
