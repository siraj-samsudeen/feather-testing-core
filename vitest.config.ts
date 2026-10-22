import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/rtl/**/*.test.tsx",
      "tests/request/**/*.test.ts",
    ],
    environment: "jsdom",
  },
});
