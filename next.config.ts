import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  turbopack: {},
  env: { NEXT_PUBLIC_OFFLINE_BUILD_ID: process.env.PUNCHLIST_BUILD_ID ?? 'development' },
  generateBuildId: async () => process.env.PUNCHLIST_BUILD_ID ?? 'development',
  async headers() {
    return [{ source: '/inspection-sw.js', headers: [
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      { key: 'Service-Worker-Allowed', value: '/' },
    ] }];
  },
};

export default nextConfig;
