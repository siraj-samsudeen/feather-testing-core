/**
 * The waiting contract: what "eventually" means for refute verbs and
 * within(), run against every driver (request, Playwright and RTL). Each
 * driver's test file calls defineWaitingContract() with its own harness.
 *
 * A page is a piece of HTML whose inline <script> runs after it is shown
 * (the browser runs it; the RTL harness runs it on the rendered DOM; the
 * request driver never runs it). Drivers that wait (`waits`) see the page
 * change while a step retries; the request driver checks once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StepError } from "../../src/errors.js";
import type { Session } from "../../src/session.js";

export interface WaitingHarness {
  /** A session already showing the page. */
  start(options?: { timeout?: number }): Session<unknown, unknown>;
  close(): Promise<void>;
}

export interface WaitingDriver {
  name: "request" | "playwright" | "rtl";
  /** Retries a step while the page changes (false: checks once). */
  waits: boolean;
  setUp(): Promise<void>;
  tearDown(): Promise<void>;
  open(html: string): Promise<WaitingHarness>;
}

const TEST_TIMEOUT = 20_000;
/** A budget for steps that are meant to fail, in well under a second. */
const FAST = { timeout: 300 };

/** Text that leaves the page 300 ms after it is shown. */
const LEAVING = `
  <p id="status">Saving draft</p>
  <p>Editor</p>
  <script>setTimeout(() => document.getElementById("status").remove(), 300);</script>`;

/** A checkbox unticked, and an attribute dropped, 300 ms after the page is shown. */
const SETTLING = `
  <form><input type="checkbox" id="pin" checked><label for="pin">Pinned</label></form>
  <div id="box" data-busy="yes"><p>Box</p></div>
  <script>setTimeout(() => {
    document.getElementById("pin").checked = false;
    document.getElementById("box").removeAttribute("data-busy");
  }, 300);</script>`;

/** An element that only appears 300 ms after the page is shown. */
const LATE = `
  <p>Waiting room</p>
  <script>setTimeout(() => {
    const late = document.createElement("section");
    late.id = "late";
    late.innerHTML = "<p>Arrived</p>";
    document.body.appendChild(late);
  }, 300);</script>`;

/** Two elements matching one selector. */
const TWO_CARDS = `<div class="card"><p>First</p></div><div class="card"><p>Second</p></div>`;

/** A scope replaced by a new element (same selector) 300 ms after the page is shown. */
const REPLACED = `
  <main id="main"><div id="panel"><p>Original</p></div></main>
  <script>setTimeout(() => {
    document.getElementById("main").innerHTML = '<div id="panel"><p>Updated</p></div>';
  }, 300);</script>`;

/** A shadow host: text in its open shadow tree, and light children slotted into it. */
const SHADOW = `
  <div id="host"><span>Slotted child</span><span>Light sibling</span></div>
  <p>Outside the host</p>
  <script>
    const root = document.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = "<p>Inside shadow</p><slot></slot>";
  </script>`;

export function defineWaitingContract(driver: WaitingDriver): void {
  describe(`waiting contract: ${driver.name} driver`, () => {
    beforeAll(() => driver.setUp(), 30_000);
    afterAll(() => driver.tearDown());

    async function withPage(html: string, fn: (h: WaitingHarness) => Promise<void>): Promise<void> {
      const harness = await driver.open(html);
      try {
        await fn(harness);
      } finally {
        await harness.close();
      }
    }

    /** The StepError a chain fails with. */
    async function failure(chain: { run(): Promise<void> }): Promise<StepError> {
      const error = await chain.run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StepError);
      return error as StepError;
    }

    const causeOf = (error: StepError) => String((error.cause as Error)?.message ?? error.cause);
    const whenWaiting = driver.waits ? it : it.skip;
    const whenScripted = driver.name === "request" ? it.skip : it;

    whenWaiting("a refute passes when the text disappears", async () => {
      await withPage(LEAVING, (h) => h.start().assertText("Editor").refuteText("Saving draft"));
    }, TEST_TIMEOUT);

    whenWaiting("refuteChecked passes when the box is unticked", async () => {
      await withPage(SETTLING, (h) => h.start().refuteChecked("Pinned"));
    }, TEST_TIMEOUT);

    whenWaiting("refuteAttribute passes when the attribute is dropped", async () => {
      await withPage(SETTLING, (h) => h.start().within("#box", (s) => s.refuteAttribute("data-busy")));
    }, TEST_TIMEOUT);

    it("a refute fails after its budget, naming what is still present", async () => {
      await withPage(`<p id="status">Saving draft</p>`, async (h) => {
        const error = await failure(h.start(FAST).refuteText("Saving draft"));
        expect(error.message).toContain("[FAILED] refuteText('Saving draft')");
        expect(causeOf(error)).toContain("still present");
        expect(causeOf(error)).toContain("Saving draft");
      });
    }, TEST_TIMEOUT);

    whenWaiting("a refute's step timeout wins over the session's", async () => {
      await withPage(LEAVING, (h) =>
        h.start({ timeout: 100 }).refuteText("Saving draft", { timeout: 5000 }),
      );
    }, TEST_TIMEOUT);

    whenWaiting("within waits for its element", async () => {
      await withPage(LATE, (h) => h.start().within("#late", (s) => s.assertText("Arrived")));
    }, TEST_TIMEOUT);

    whenWaiting("within's step timeout wins over the session's", async () => {
      await withPage(LATE, (h) =>
        h.start({ timeout: 100 }).within("#late", (s) => s.assertText("Arrived"), {
          timeout: 5000,
        }),
      );
    }, TEST_TIMEOUT);

    it("within requires exactly one match: several fail naming the count", async () => {
      await withPage(TWO_CARDS, async (h) => {
        const error = await failure(h.start(FAST).within(".card", (s) => s.assertText("First")));
        expect(error.message).toContain("[FAILED] within('.card')");
        expect(causeOf(error)).toContain("matched 2 elements");
      });
    }, TEST_TIMEOUT);

    it("within requires exactly one match: none fails naming the count", async () => {
      await withPage(TWO_CARDS, async (h) => {
        const error = await failure(h.start(FAST).within("#missing", (s) => s.assertText("First")));
        expect(causeOf(error)).toContain("matched 0 elements");
      });
    }, TEST_TIMEOUT);

    whenWaiting("within looks its selector up again at every step", async () => {
      await withPage(REPLACED, (h) =>
        h.start().within("#panel", (s) => s.assertText("Original").assertText("Updated")),
      );
    }, TEST_TIMEOUT);

    whenScripted("within on a shadow host reaches into its shadow root", async () => {
      await withPage(SHADOW, (h) => h.start().within("#host", (s) => s.assertText("Inside shadow")));
    }, TEST_TIMEOUT);

    whenScripted("within on a shadow host keeps its slotted children", async () => {
      await withPage(SHADOW, (h) => h.start().within("#host", (s) => s.assertText("Slotted child")));
    }, TEST_TIMEOUT);

    whenScripted("within on a shadow host leaves out what is outside the host", async () => {
      await withPage(SHADOW, (h) =>
        h.start().within("#host", (s) => s.refuteText("Outside the host", FAST)),
      );
    }, TEST_TIMEOUT);
  });
}
