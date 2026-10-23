// @vitest-environment node
import { describe, expect, it } from "vitest";
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
    expect(cookieHeaderFor(cookies, new URL("http://www.example.com/"))).toBe("a=1; f=6; g=7");
    expect(cookieHeaderFor(cookies, "http://localhost/")).toBe("a=1; d=4; f=6");
  });

  it("is null when no cookie matches", () => {
    expect(cookieHeaderFor([{ name: "c", value: "3", domain: "other.org" }], "http://example.com/")).toBeNull();
  });
});
