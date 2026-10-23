// @vitest-environment node
/**
 * feather-testing-core/cookies gives cookieHeaderFor without the request
 * adapter's DOM parser: nothing it imports, transitively, loads happy-dom.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cookieHeaderFor } from "../../src/cookies/index.js";
import { cookieHeaderFor as fromRoot } from "../../src/index.js";

/** Every module a source file imports, transitively (relative imports followed). */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = match[1] ?? match[2]!;
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe("feather-testing-core/cookies", () => {
  it("exports cookieHeaderFor, also from the root", () => {
    expect(cookieHeaderFor([{ name: "a", value: "1" }], "http://x.test/")).toBe("a=1");
    expect(fromRoot).toBe(cookieHeaderFor);
  });

  it("the import walk sees imports (it can fail)", () => {
    // The request adapter's entry does load happy-dom's module (via dom.ts).
    const { files } = importGraph(resolve("src/request/index.ts"));
    expect(files.some((f) => f.endsWith("/request/dom.ts"))).toBe(true);
    expect(importGraph(resolve("src/cookies/index.ts")).files.map((f) => f.split("/src/")[1])).toEqual([
      "cookies/index.ts",
      "request/cookies.ts",
      "types.ts",
    ]);
  });

  it("does not load happy-dom (nor any other package), from /cookies or the root", () => {
    for (const entry of ["src/cookies/index.ts", "src/index.ts"]) {
      const { packages, files } = importGraph(resolve(entry));
      expect(files.length).toBeGreaterThan(1);
      expect(packages).toEqual([]);
      expect(files.some((f) => /happy-dom|[\\/]request[\\/](browser|dom|driver)\.ts$/.test(f))).toBe(false);
    }
  });
});
