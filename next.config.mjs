/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source files live under ./src — prevents Next.js from scanning a root-level /app
  // (which was previously a stale folder that caused 404 issues)
  experimental: {},
};

export default nextConfig;
