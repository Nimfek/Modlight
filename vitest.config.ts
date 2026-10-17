import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` is a build-time guard, not a runtime module: Next resolves
      // it to something that throws if a client bundle ever pulls the file in.
      // Outside Next there is nothing to resolve, so a server-side module that
      // carries the guard cannot be unit-tested at all without this. Pointing it
      // at an empty stub keeps the guard where it belongs (in the real build)
      // and lets the tests import the module.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
