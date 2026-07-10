import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS project. Without this, Next detects a stray
  // package-lock.json in the home folder and guesses the wrong root.
  turbopack: {
    root: __dirname,
  },
  // Bakes the deployed commit SHA into the client bundle at build time (via
  // Vercel's auto-injected VERCEL_GIT_COMMIT_SHA). Compared against
  // /api/version's live read of the same var to detect a stale tab running
  // an old build — see app/api/version/route.ts + the version-check effect
  // in components/Dashboard.tsx.
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
  },
};

export default nextConfig;
