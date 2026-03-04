import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  use: {
    baseURL: "http://testapp.local",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
