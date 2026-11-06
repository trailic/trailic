import type { NextConfig } from "next";
import { collectorOnly, hostOfCollector, notOnTheCollector } from "./src/domain/collector-address";

const collectorHost = hostOfCollector(process.env.TRAILIC_COLLECTOR_URL);

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Without a page of its own, the root needs no rendering, no session and no database.
  redirects: async () => [{ source: "/", destination: "/overview", permanent: false, ...notOnTheCollector(collectorHost) }],
  rewrites: async () => ({ beforeFiles: collectorOnly(collectorHost), afterFiles: [], fallback: [] }),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
