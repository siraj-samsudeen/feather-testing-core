// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { cookieHeaderFor } from "../../src/request/index.js";

describe("cookieHeaderFor(cookies, url)", () => {
  const now = Math.floor(Date.now() / 1000);

  it("builds the Cookie header a browser would send, honouring domain, path, secure and expiry", () => {
    const cookies = [
      { name: "a", value: "1" }, // no domain: the url's host
      { name: "b", value: "2", domain: "example.com", path: "/app" },
      { name: "c", value: "3", domain: "other.org" },
      { name: "d", value: "4", secure: true },
      { name: "e", value: "5", expires: now - 60 }, // expired
      { name: "f", value: "6", expires: -1 }, // session cookie
      { name: "g", value: "7", domain: ".example.com" }, // subdomains too
    ];
    expect(cookieHeaderFor(cookies, "http://example.com/app/page")).toBe("b=2; a=1; f=6; g=7");
    expect(cookieHeaderFor(cookies, "https://example.com/")).toBe("a=1; d=4; f=6; g=7");
    // b's domain has no leading dot: example.com only (host-only), as
    // context.cookies() reports host-only cookies.
    expect(cookieHeaderFor(cookies, new URL("http://www.example.com/app/x"))).toBe("a=1; f=6; g=7");
    expect(cookieHeaderFor(cookies, "http://localhost/")).toBe("a=1; d=4; f=6");
  });

  it("is null when no cookie matches", () => {
    expect(cookieHeaderFor([{ name: "c", value: "3", domain: "other.org" }], "http://example.com/")).toBeNull();
  });

  it("keeps host-only and domain cookies apart, as context.cookies() reports them", async () => {
    // Real output: Playwright reports a host-only cookie with a bare domain
    // ("example.com") and a domain cookie with a leading dot (".example.com").
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: "hostOnly", value: "1", url: "http://example.com/" },
        { name: "wide", value: "2", domain: ".example.com", path: "/" },
      ]);
      const cookies = await context.cookies();
      expect(cookies.find((c) => c.name === "hostOnly")?.domain).toBe("example.com");
      expect(cookieHeaderFor(cookies, "http://example.com/")).toBe("hostOnly=1; wide=2");
      expect(cookieHeaderFor(cookies, "http://sub.example.com/")).toBe("wide=2");
    } finally {
      await browser.close();
    }
  }, 20_000);
});
