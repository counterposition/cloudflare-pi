import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Real workerd runtime via the Cloudflare Workers Vitest pool.
      // Durable SQLite adapter tests run against real workerd Durable
      // SQLite via the adapter-owned isolated fixture (test/wrangler.jsonc
      // + test/durable-sqlite.fixture.ts), with no dependency on
      // src/index.ts or the app wrangler.jsonc.
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
        test: {
          name: "workers",
          include: ["test/durable-sqlite.test.ts", "test/sandbox-control.test.ts"],
        },
      },
      // Node runtime for tests that do not need workerd: sandbox-env
      // fs-helper tests (real node:child_process) and auth tests live here.
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/durable-sqlite.test.ts", "test/sandbox-control.test.ts"],
        },
      },
    ],
  },
});
