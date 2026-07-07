import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS project. Without this, Next detects a stray
  // package-lock.json in the home folder and guesses the wrong root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
