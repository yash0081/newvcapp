import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  allowedDevOrigins: [
    // Allow tunneling dev origins (e.g. ngrok) so HMR/WebSocket works.
    // Add your current ngrok host here (no protocol).
    "sensitive-mortified-unnamable.ngrok-free.dev",
  ],
};

export default nextConfig;
