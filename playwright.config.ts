import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "src/ui",
  testMatch: "**/*.e2e.ts",
  reporter: [["list"], ["json", { outputFile: "test-results.json" }]],
  use: {
    baseURL: "http://localhost:3000"
  }
});
