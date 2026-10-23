// @vitest-environment node
/** The playwright peer floor is never below what the adapter's code needs. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_PLAYWRIGHT_VERSION } from "../../src/playwright/driver.js";

const parse = (v: string) => v.split(".").map(Number) as [number, number, number];
const compare = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

describe("playwright peer floor", () => {
  it("is at least MIN_PLAYWRIGHT_VERSION", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    const range = pkg.peerDependencies.playwright!;
    const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range)?.[1];
    expect(floor, `expected a ">=x.y.z" range, got "${range}"`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compare(floor!, MIN_PLAYWRIGHT_VERSION)).toBeGreaterThanOrEqual(0);
  });
});
