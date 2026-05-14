import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/architecture/**/*.test.ts"],
    environment: "node",
  },
});
