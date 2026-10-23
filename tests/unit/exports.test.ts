// @vitest-environment node
/** SessionCookie is exported from every entry point a consumer imports from. */
import { describe, expect, it } from "vitest";
import type { SessionCookie as FromRoot } from "../../src/index.js";
import type { SessionCookie as FromPlaywright } from "../../src/playwright/index.js";
import type { SessionCookie as FromRequest } from "../../src/request/index.js";
import type { SessionCookie as FromFixtures } from "../../src/fixtures/index.js";
import type { SessionCookie as FromRtl } from "../../src/rtl/index.js";

describe("SessionCookie export", () => {
  it("is the same type from every entry point", () => {
    const cookie: FromRoot = { name: "session", value: "v", path: "/", expires: -1 };
    const all: [FromPlaywright, FromRequest, FromFixtures, FromRtl] = [cookie, cookie, cookie, cookie];
    expect(all.map((c) => c.name)).toEqual(["session", "session", "session", "session"]);
  });
});
