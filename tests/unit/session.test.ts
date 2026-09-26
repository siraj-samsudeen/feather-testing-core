import { describe, it, expect, vi } from "vitest";
import { Session } from "../../src/session.js";
import { StepError } from "../../src/errors.js";
import type { TestDriver } from "../../src/types.js";

/**
 * Creates a mock TestDriver that records all method calls.
 * Every method resolves successfully unless overridden.
 */
function createMockDriver(overrides?: Partial<TestDriver>): {
  driver: TestDriver;
  calls: string[];
} {
  const calls: string[] = [];

  const handler = (name: string) => {
    return (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return Promise.resolve();
    };
  };

  const driver: TestDriver = {
    visit: vi.fn(handler("visit")),
    reload: vi.fn(handler("reload")),
    click: vi.fn(handler("click")),
    clickLink: vi.fn(handler("clickLink")),
    clickButton: vi.fn(handler("clickButton")),
    fillIn: vi.fn(handler("fillIn")),
    selectOption: vi.fn(handler("selectOption")),
    check: vi.fn(handler("check")),
    uncheck: vi.fn(handler("uncheck")),
    choose: vi.fn(handler("choose")),
    submit: vi.fn(handler("submit")),
    attachFile: vi.fn(handler("attachFile")),
    upload: vi.fn(handler("upload")),
    dropFile: vi.fn(handler("dropFile")),
    pressKey: vi.fn(handler("pressKey")),
    hover: vi.fn(handler("hover")),
    assertText: vi.fn(handler("assertText")),
    assertExactText: vi.fn(handler("assertExactText")),
    refuteText: vi.fn(handler("refuteText")),
    assertAttribute: vi.fn(handler("assertAttribute")),
    refuteAttribute: vi.fn(handler("refuteAttribute")),
    assertComputedStyle: vi.fn(handler("assertComputedStyle")),
    assertNoHorizontalOverflow: vi.fn(handler("assertNoHorizontalOverflow")),
    assertHorizontalOverflow: vi.fn(handler("assertHorizontalOverflow")),
    assertHorizontallyContained: vi.fn(handler("assertHorizontallyContained")),
    scrollToHorizontalEnd: vi.fn(handler("scrollToHorizontalEnd")),
    assertValue: vi.fn(handler("assertValue")),
    assertChecked: vi.fn(handler("assertChecked")),
    refuteChecked: vi.fn(handler("refuteChecked")),
    assertSelected: vi.fn(handler("assertSelected")),
    assertOptions: vi.fn(handler("assertOptions")),
    assertHas: vi.fn(handler("assertHas")),
    refuteHas: vi.fn(handler("refuteHas")),
    assertPath: vi.fn(handler("assertPath")),
    refutePath: vi.fn(handler("refutePath")),
    assertDownload: vi.fn(
      async (expected: string | RegExp, trigger: () => Promise<void>) => {
        calls.push(`assertDownload(${JSON.stringify(String(expected))})`);
        await trigger();
      },
    ),
    raw: vi.fn(async (fn: (native: unknown) => unknown) => {
      calls.push("raw");
      await fn({ native: true });
    }),
    until: vi.fn(
      async (description: string, predicate: (c: unknown) => unknown) => {
        calls.push(`until(${JSON.stringify(description)})`);
        // A single poll is enough for a mock: the real drivers own retrying.
        if (!(await predicate({ mock: true }))) {
          throw new Error(
            `until: ${description} — condition was still not met.`,
          );
        }
      },
    ),
    step: vi.fn(async (fn: (context: unknown) => Promise<unknown>) => {
      calls.push("step");
      await fn({ mock: true });
    }),
    within: vi.fn(async (selector: string) => {
      calls.push(`within(${JSON.stringify(selector)})`);
      // Return a new mock driver for the scoped session
      return createMockDriver().driver;
    }),
    debug: vi.fn(handler("debug")),
    ...overrides,
  };

  return { driver, calls };
}

describe("Session", () => {
  describe("chaining", () => {
    it("every method returns the same session instance", () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      // Each method should return `this`
      const result = session
        .visit("/")
        .reload()
        .click("text")
        .clickLink("link")
        .clickButton("btn")
        .fillIn("label", "value")
        .selectOption("label", "option")
        .check("label")
        .uncheck("label")
        .choose("label")
        .submit()
        .attachFile("label", "path.txt")
        .upload("label", "path.txt")
        .dropFile(".zone", "path.txt")
        .pressKey("Enter")
        .hover("text")
        .assertText("text")
        .assertExactText("exact text")
        .refuteText("text")
        .assertAttribute("data-state", "ready")
        .refuteAttribute("disabled")
        .assertComputedStyle("color", "rgb(0, 0, 0)")
        .assertNoHorizontalOverflow()
        .assertHorizontalOverflow()
        .assertHorizontallyContained(".action")
        .scrollToHorizontalEnd()
        .assertValue("label", "value")
        .assertChecked("label")
        .refuteChecked("label")
        .assertSelected("label", "option")
        .assertOptions("label", ["a", "b"])
        .assertHas("selector")
        .refuteHas("selector")
        .assertPath("/path")
        .refutePath("/path")
        .until("the page settles", () => true)
        .step("custom", async () => {})
        .raw("native poke", async () => {})
        .debug();

      // result is the same session (not yet awaited)
      expect(result).toBe(session);
    });
  });

  describe("queue execution", () => {
    it("executes all steps in order when awaited", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      await session
        .visit("/")
        .fillIn("Email", "test@example.com")
        .clickButton("Sign in")
        .assertText("Welcome");

      expect(calls).toEqual([
        'visit("/")',
        'fillIn("Email", "test@example.com")',
        'clickButton("Sign in")',
        'assertText("Welcome")',
      ]);
    });

    it("does nothing without await", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      // No await — just chain
      session.visit("/").clickButton("Go");

      // Let every pending microtask run: the queue only executes on await,
      // so if anything were going to fire on its own it would have by now.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual([]);
    });

    it("resets the queue after await, allowing a second chain", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      await session.visit("/").fillIn("Name", "Alice");
      expect(calls).toEqual(['visit("/")', 'fillIn("Name", "Alice")']);

      calls.length = 0; // reset tracking

      await session.clickButton("Submit").assertText("Done");
      expect(calls).toEqual(['clickButton("Submit")', 'assertText("Done")']);
    });

    it("resolves without error for empty chain", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);
      await session; // no steps
    });

    it("passes correct arguments to each driver method", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      await session
        .visit("/path")
        .reload()
        .click("some text")
        .clickLink("my link")
        .clickButton("my button")
        .fillIn("Email", "a@b.com")
        .selectOption("Color", "Red")
        .check("Newsletter")
        .uncheck("Ads")
        .choose("Plan A")
        .submit()
        .upload("Avatar", "avatar.png")
        .dropFile("#zone", "doc.pdf")
        .assertText("Hello")
        .assertExactText("Exact total", { timeout: 250 })
        .refuteText("Goodbye")
        .assertAttribute("data-state", "ready", { timeout: 250 })
        .refuteAttribute("disabled", { timeout: 250 })
        .assertComputedStyle("--color-brand", "#c15f3c", { timeout: 250 })
        .assertNoHorizontalOverflow({ timeout: 250, tolerance: 2 })
        .assertHorizontalOverflow({ timeout: 250, tolerance: 2 })
        .assertHorizontallyContained(".action", {
          timeout: 250,
          tolerance: 2,
        })
        .scrollToHorizontalEnd({ timeout: 250, tolerance: 2 })
        .assertValue("Email", "a@b.com")
        .assertChecked("Newsletter")
        .refuteChecked("Ads")
        .assertSelected("Color", "Red")
        .assertOptions("Color", ["Red", "Blue"])
        .assertHas("div.card", { text: "hi", count: 2 })
        .refuteHas("span.error")
        .assertPath("/done", { queryParams: { id: "1" } })
        .refutePath("/login")
        .debug();

      expect(driver.visit).toHaveBeenCalledWith("/path");
      expect(driver.reload).toHaveBeenCalledWith();
      expect(driver.click).toHaveBeenCalledWith("some text");
      expect(driver.clickLink).toHaveBeenCalledWith("my link");
      expect(driver.clickButton).toHaveBeenCalledWith("my button");
      expect(driver.fillIn).toHaveBeenCalledWith("Email", "a@b.com");
      expect(driver.selectOption).toHaveBeenCalledWith("Color", "Red");
      expect(driver.check).toHaveBeenCalledWith("Newsletter");
      expect(driver.uncheck).toHaveBeenCalledWith("Ads");
      expect(driver.choose).toHaveBeenCalledWith("Plan A");
      expect(driver.submit).toHaveBeenCalled();
      expect(driver.upload).toHaveBeenCalledWith("Avatar", "avatar.png");
      expect(driver.dropFile).toHaveBeenCalledWith("#zone", "doc.pdf");
      expect(driver.assertText).toHaveBeenCalledWith("Hello");
      expect(driver.assertExactText).toHaveBeenCalledWith("Exact total", {
        timeout: 250,
      });
      expect(driver.refuteText).toHaveBeenCalledWith("Goodbye");
      expect(driver.assertAttribute).toHaveBeenCalledWith(
        "data-state",
        "ready",
        { timeout: 250 },
      );
      expect(driver.refuteAttribute).toHaveBeenCalledWith("disabled", {
        timeout: 250,
      });
      expect(driver.assertComputedStyle).toHaveBeenCalledWith(
        "--color-brand",
        "#c15f3c",
        { timeout: 250 },
      );
      expect(driver.assertNoHorizontalOverflow).toHaveBeenCalledWith({
        timeout: 250,
        tolerance: 2,
      });
      expect(driver.assertHorizontalOverflow).toHaveBeenCalledWith({
        timeout: 250,
        tolerance: 2,
      });
      expect(driver.assertHorizontallyContained).toHaveBeenCalledWith(
        ".action",
        { timeout: 250, tolerance: 2 },
      );
      expect(driver.scrollToHorizontalEnd).toHaveBeenCalledWith({
        timeout: 250,
        tolerance: 2,
      });
      expect(driver.assertValue).toHaveBeenCalledWith("Email", "a@b.com");
      expect(driver.assertChecked).toHaveBeenCalledWith("Newsletter");
      expect(driver.refuteChecked).toHaveBeenCalledWith("Ads");
      expect(driver.assertSelected).toHaveBeenCalledWith("Color", "Red");
      expect(driver.assertOptions).toHaveBeenCalledWith("Color", [
        "Red",
        "Blue",
      ]);
      expect(driver.assertHas).toHaveBeenCalledWith("div.card", {
        text: "hi",
        count: 2,
      });
      expect(driver.refuteHas).toHaveBeenCalledWith("span.error", undefined);
      expect(driver.assertPath).toHaveBeenCalledWith("/done", {
        queryParams: { id: "1" },
      });
      expect(driver.refutePath).toHaveBeenCalledWith("/login");
      expect(driver.debug).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("wraps a failing step in StepError", async () => {
      const { driver } = createMockDriver({
        clickButton: vi.fn(async () => {
          throw new Error("button not found");
        }),
      });
      const session = new Session(driver);

      await expect(
        session.visit("/").clickButton("Go").assertText("Done"),
      ).rejects.toThrow(StepError);
    });

    it("StepError contains the correct step number", async () => {
      const { driver } = createMockDriver({
        assertText: vi.fn(async () => {
          throw new Error("text not found");
        }),
      });
      const session = new Session(driver);

      try {
        await session.visit("/").fillIn("Name", "x").assertText("Done");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(StepError);
        expect((e as StepError).message).toContain("Step 3 of 3 failed");
      }
    });

    it("stops execution after a failure (skips remaining steps)", async () => {
      const { driver, calls } = createMockDriver({
        clickButton: vi.fn(async () => {
          throw new Error("fail");
        }),
      });
      const session = new Session(driver);

      try {
        await session
          .visit("/")
          .clickButton("Go")
          .assertText("Done")
          .assertPath("/done");
      } catch {
        // expected
      }

      // visit ran, clickButton ran (and threw), rest were skipped
      expect(calls).toEqual(['visit("/")']);
      // clickButton was called but it's not in `calls` because the mock override doesn't push to calls
      expect(driver.clickButton).toHaveBeenCalled();
      expect(driver.assertText).not.toHaveBeenCalled();
      expect(driver.assertPath).not.toHaveBeenCalled();
    });

    it("StepError message includes skipped steps", async () => {
      const { driver } = createMockDriver({
        fillIn: vi.fn(async () => {
          throw new Error("input not found");
        }),
      });
      const session = new Session(driver);

      try {
        await session
          .visit("/")
          .fillIn("Name", "x")
          .clickButton("Go")
          .assertText("Done");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain("[ok] visit('/')");
        expect(msg).toContain("[FAILED] fillIn('Name', 'x')");
        expect(msg).toContain("[skipped] clickButton('Go')");
        expect(msg).toContain("[skipped] assertText('Done')");
      }
    });

    it("preserves the original error as cause", async () => {
      const originalError = new Error("original");
      const { driver } = createMockDriver({
        visit: vi.fn(async () => {
          throw originalError;
        }),
      });
      const session = new Session(driver);

      try {
        await session.visit("/");
        expect.fail("should have thrown");
      } catch (e) {
        expect((e as StepError).cause).toBe(originalError);
      }
    });
  });

  describe("within()", () => {
    it("calls driver.within with the selector and executes scoped actions", async () => {
      const scopedCalls: string[] = [];
      const scopedDriver: TestDriver = {
        ...createMockDriver().driver,
        clickButton: vi.fn(async (text: string) => {
          scopedCalls.push(`clickButton(${text})`);
        }),
        assertText: vi.fn(async (text: string) => {
          scopedCalls.push(`assertText(${text})`);
        }),
      };

      const { driver, calls } = createMockDriver({
        within: vi.fn(async (selector: string) => {
          calls.push(`within(${JSON.stringify(selector)})`);
          return scopedDriver;
        }),
      });
      const session = new Session(driver);

      await session.within(".sidebar", (s) =>
        s.clickButton("Settings").assertText("Preferences"),
      );

      expect(calls).toEqual(['within(".sidebar")']);
      expect(scopedCalls).toEqual([
        "clickButton(Settings)",
        "assertText(Preferences)",
      ]);
    });

    it("continues the parent chain after within()", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      await session
        .visit("/")
        .within(".sidebar", (s) => s.clickButton("Go"))
        .assertText("Done");

      expect(calls[0]).toBe('visit("/")');
      // within is calls[1]
      expect(calls[2]).toBe('assertText("Done")');
    });
  });

  describe("step() escape hatch", () => {
    it("passes the driver-provided context to the callback", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      let received: unknown;
      await session.step("custom work", async (context) => {
        received = context;
      });

      expect(received).toEqual({ mock: true });
      expect(driver.step).toHaveBeenCalled();
    });

    it("shows the step name in StepError when it fails", async () => {
      const { driver } = createMockDriver({
        step: vi.fn(async (fn: (context: unknown) => Promise<unknown>) => {
          await fn({});
        }),
      });
      const session = new Session(driver);

      try {
        await session.visit("/").step("drag the card", async () => {
          throw new Error("drag failed");
        });
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain(">>> [FAILED] step('drag the card')");
        expect(msg).toContain("Cause: drag failed");
      }
    });
  });

  describe("raw() escape hatch", () => {
    it("hands the driver's native handle to the callback", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      let received: unknown;
      await session.raw("poke the page", (native) => {
        received = native;
      });

      expect(received).toEqual({ native: true });
      expect(calls).toEqual(["raw"]);
    });

    it("registers as a named step in the chain trace", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      try {
        await session
          .visit("/")
          .raw("drag the card to Done", () => {
            throw new Error("drag failed");
          })
          .assertText("Done (1)");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain("    [ok] visit('/')");
        expect(msg).toContain(">>> [FAILED] raw('drag the card to Done')");
        expect(msg).toContain("    [skipped] assertText('Done (1)')");
        expect(msg).toContain("Cause: drag failed");
      }
    });

    it("rejects a missing or blank label at the call site", () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      expect(() => session.raw("", () => {})).toThrow(
        /raw\(\) requires a non-empty description/,
      );
    });
  });

  describe("new verbs", () => {
    it("attachFile goes straight to the driver", async () => {
      const { driver, calls } = createMockDriver();
      await new Session(driver).attachFile("Avatar", "photo.png");

      expect(driver.attachFile).toHaveBeenCalledWith("Avatar", "photo.png");
      expect(calls).toEqual(['attachFile("Avatar", "photo.png")']);
    });

    it("upload stays as a deprecated alias for attachFile", async () => {
      const { driver } = createMockDriver();
      await new Session(driver).upload("Avatar", "photo.png");

      expect(driver.upload).toHaveBeenCalledWith("Avatar", "photo.png");
    });

    it("upload falls back to attachFile on drivers that dropped it", async () => {
      const { driver } = createMockDriver();
      delete (driver as { upload?: unknown }).upload;

      await new Session(driver).upload("Avatar", "photo.png");

      expect(driver.attachFile).toHaveBeenCalledWith("Avatar", "photo.png");
    });

    it("pressKey and hover name their target in the trace", async () => {
      const { driver, calls } = createMockDriver();
      await new Session(driver).pressKey("Control+A").hover("Total");

      expect(calls).toEqual(['pressKey("Control+A")', 'hover("Total")']);
    });

    it("assertDownload runs the trigger against the same driver", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      await session.assertDownload("report.csv", (s) =>
        s.clickButton("Export"),
      );

      expect(calls).toEqual([
        'assertDownload("report.csv")',
        'clickButton("Export")',
      ]);
      expect(driver.assertDownload).toHaveBeenCalledWith(
        "report.csv",
        expect.any(Function),
        undefined,
      );
    });

    it("assertDownload names the expectation in the trace when it fails", async () => {
      const { driver } = createMockDriver({
        assertDownload: vi.fn(async () => {
          throw new Error("no download started");
        }),
      });

      try {
        await new Session(driver).assertDownload(/report-\d+\.csv/, (s) =>
          s.clickButton("Export"),
        );
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain(
          ">>> [FAILED] assertDownload('/report-\\d+\\.csv/')",
        );
        expect(msg).toContain("Cause: no download started");
      }
    });
  });

  describe("until()", () => {
    it("passes the driver-provided context to the predicate", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      let received: unknown;
      await session.until("the list is loaded", (context) => {
        received = context;
        return true;
      });

      expect(received).toEqual({ mock: true });
      expect(calls).toEqual(['until("the list is loaded")']);
    });

    it("forwards timeout and interval options to the driver", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      await session.until("the badge clears", () => true, {
        timeout: 1234,
        interval: 50,
      });

      expect(driver.until).toHaveBeenCalledWith(
        "the badge clears",
        expect.any(Function),
        { timeout: 1234, interval: 50 },
      );
    });

    it("names the awaited condition in the chain trace when it times out", async () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      try {
        await session
          .visit("/")
          .until("the export job finishes", () => false)
          .assertText("Done");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain("    [ok] visit('/')");
        expect(msg).toContain(">>> [FAILED] until: the export job finishes");
        expect(msg).toContain("    [skipped] assertText('Done')");
      }
    });

    it("rejects a missing or blank description at the call site", () => {
      const { driver } = createMockDriver();
      const session = new Session(driver);

      expect(() => session.until("", () => true)).toThrow(
        /until\(\) requires a non-empty description/,
      );
      expect(() => session.until("   ", () => true)).toThrow(
        /until\(\) requires a non-empty description/,
      );
      expect(() =>
        // A JS caller with no types still gets the guard.
        (session as unknown as { until: (...a: unknown[]) => unknown }).until(
          () => true,
        ),
      ).toThrow(/until\(\) requires a non-empty description/);
    });
  });

  describe("session-level step history", () => {
    it("includes steps from earlier chains in StepError", async () => {
      const { driver } = createMockDriver({
        assertText: vi.fn(async () => {
          throw new Error("fail");
        }),
      });
      const session = new Session(driver);

      // First chain: 2 steps (indices 0, 1)
      await session.visit("/").clickButton("Go");

      // Second chain fails: StepError shows the full walk across chains
      try {
        await session.fillIn("Name", "x").assertText("Done");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain("Step 4 of 4 failed");
        expect(msg).toContain("    [ok] visit('/')");
        expect(msg).toContain("    [ok] clickButton('Go')");
        expect(msg).toContain("    [ok] fillIn('Name', 'x')");
        expect(msg).toContain(">>> [FAILED] assertText('Done')");
      }
    });

    it("marks steps after the failure as skipped across chains", async () => {
      const { driver } = createMockDriver({
        fillIn: vi.fn(async () => {
          throw new Error("input not found");
        }),
      });
      const session = new Session(driver);

      await session.visit("/");

      try {
        await session.fillIn("Name", "x").clickButton("Go");
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as StepError).message;
        expect(msg).toContain("Step 2 of 3 failed");
        expect(msg).toContain("    [ok] visit('/')");
        expect(msg).toContain(">>> [FAILED] fillIn('Name', 'x')");
        expect(msg).toContain("    [skipped] clickButton('Go')");
      }
    });
  });

  describe("wrapStep hook", () => {
    it("wraps each step execution when the driver provides wrapStep", async () => {
      const wrapped: string[] = [];
      const { driver } = createMockDriver();
      driver.wrapStep = vi.fn(
        async (name: string, fn: () => Promise<void>) => {
          wrapped.push(name);
          await fn();
        },
      );
      const session = new Session(driver);

      await session.visit("/").clickButton("Go");

      expect(wrapped).toEqual(["visit('/')", "clickButton('Go')"]);
    });
  });
});
