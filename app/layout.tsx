import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Investment Deep Research Engine",
  description: "",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
