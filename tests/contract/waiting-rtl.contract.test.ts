/**
 * The waiting contract (tests/contract/waiting.ts) on the RTL driver: the
 * page is rendered into document.body (jsdom under Vitest, happy-dom under
 * bun) and its inline scripts run on it, their timers cleared on close.
 */
import { cleanup } from "@testing-library/react";
import { createSession } from "../../src/rtl/index.js";
import type { Session } from "../../src/session.js";
import { defineWaitingContract } from "./waiting.js";

defineWaitingContract({
  name: "rtl",
  waits: true,
  async setUp() {},
  async tearDown() {},
  async open(html) {
    // The page's own timers (its script's setTimeout), kept to clear on close.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = globalThis.setTimeout.bind(globalThis);
    const later = (fn: () => void, ms?: number) => {
      const id = schedule(fn, ms);
      timers.push(id);
      return id;
    };
    document.body.innerHTML = html;
    for (const script of Array.from(document.body.querySelectorAll("script"))) {
      new Function("setTimeout", script.textContent ?? "")(later);
      script.remove();
    }
    return {
      start: (options) => createSession(options) as unknown as Session<unknown, unknown>,
      close: async () => {
        timers.forEach((id) => clearTimeout(id));
        cleanup();
        document.body.innerHTML = "";
      },
    };
  },
});
