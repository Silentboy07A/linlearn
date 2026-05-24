/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},

  // ── Webpack: handle Web Workers & WASM ────────────────────────────────────
  webpack(config, { isServer }) {
    if (!isServer) {
      // Let Webpack 5 handle `new Worker(new URL(..., import.meta.url))`
      // by NOT interfering — Webpack 5 detects this pattern natively.
      // We only need to make sure .wasm files are treated as assets.
      config.module.rules.push({
        test: /\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "static/wasm/[name][ext]",
        },
      });
    }
    return config;
  },

  // ── Headers ───────────────────────────────────────────────────────────────
  async headers() {
    return [
      // ── COOP/COEP for SharedArrayBuffer (required by v86 WASM) ──────────
      // These headers enable cross-origin isolation which unlocks
      // SharedArrayBuffer — required for v86's multi-threaded execution.
      {
        source: "/(.*)",
        headers: [
          // Security headers
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Cross-Origin Isolation — enables SharedArrayBuffer
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp",
          },
        ],
      },
      // ── WASM binary — correct MIME + immutable cache ────────────────────
      {
        source: "/v86/:path*.wasm",
        headers: [
          { key: "Content-Type", value: "application/wasm" },
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // ── BIOS/VGA binaries — immutable cache ─────────────────────────────
      {
        source: "/v86/bios/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // ── Kernel + rootfs images ──────────────────────────────────────────
      {
        source: "/v86/images/:path*",
        headers: [
          { key: "Accept-Ranges", value: "bytes" },
          {
            key: "Cache-Control",
            value: "public, max-age=86400",
          },
        ],
      },
      // ── libv86.js runtime — immutable cache ─────────────────────────────
      {
        source: "/v86/libv86.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
