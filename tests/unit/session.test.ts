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
      // Options a step did not set arrive as trailing undefined: leave them out.
      const given = [...args];
      while (given.length > 0 && given[given.length - 1] === undefined) given.pop();
      calls.push(`${name}(${given.map((a) => JSON.stringify(a)).join(", ")})`);
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
      expect(driver.click).toHaveBeenCalledWith("some text", undefined);
      expect(driver.clickLink).toHaveBeenCalledWith("my link", undefined);
      expect(driver.clickButton).toHaveBeenCalledWith("my button", undefined);
      expect(driver.fillIn).toHaveBeenCalledWith("Email", "a@b.com", undefined);
      expect(driver.selectOption).toHaveBeenCalledWith("Color", "Red", undefined);
      expect(driver.check).toHaveBeenCalledWith("Newsletter", undefined);
      expect(driver.uncheck).toHaveBeenCalledWith("Ads", undefined);
      expect(driver.choose).toHaveBeenCalledWith("Plan A", undefined);
      expect(driver.submit).toHaveBeenCalled();
      expect(driver.upload).toHaveBeenCalledWith("Avatar", "avatar.png");
      expect(driver.dropFile).toHaveBeenCalledWith("#zone", "doc.pdf");
      expect(driver.assertText).toHaveBeenCalledWith("Hello", undefined);
      expect(driver.assertExactText).toHaveBeenCalledWith("Exact total", {
        timeout: 250,
      });
      expect(driver.refuteText).toHaveBeenCalledWith("Goodbye", undefined);
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
      expect(driver.assertValue).toHaveBeenCalledWith("Email", "a@b.com", undefined);
      expect(driver.assertChecked).toHaveBeenCalledWith("Newsletter", undefined);
      expect(driver.refuteChecked).toHaveBeenCalledWith("Ads", undefined);
      expect(driver.assertSelected).toHaveBeenCalledWith("Color", "Red", undefined);
      expect(driver.assertOptions).toHaveBeenCalledWith(
        "Color",
        ["Red", "Blue"],
        undefined,
      );
      expect(driver.assertHas).toHaveBeenCalledWith("div.card", {
        text: "hi",
        count: 2,
      });
      expect(driver.refuteHas).toHaveBeenCalledWith("span.error", undefined);
      expect(driver.assertPath).toHaveBeenCalledWith("/done", {
        queryParams: { id: "1" },
      });
      expect(driver.refutePath).toHaveBeenCalledWith("/login", undefined);
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

      // run() hands expect() a real Promise: bun test's .rejects needs one.
      await expect(
        session.visit("/").clickButton("Go").assertText("Done").run(),
      ).rejects.toThrow(StepError);
    });

    it("run() returns a real Promise that runs the queued steps", async () => {
      const { driver, calls } = createMockDriver();
      const session = new Session(driver);

      const running = session.visit("/").clickButton("Go").run();

      expect(running).toBeInstanceOf(Promise);
      await expect(running).resolves.toBeUndefined();
      expect(calls).toEqual(['visit("/")', 'clickButton("Go")']);
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

    /** A driver whose within() scopes to itself, so one call log shows everything. */
    function selfScopingDriver() {
      const mock = createMockDriver();
      mock.driver.within = vi.fn(async () => mock.driver);
      return mock;
    }

    it("still runs steps the callback awaited itself", async () => {
      const { driver, calls } = selfScopingDriver();
      await new Session(driver).within(".form", async (s) => {
        await s.fillIn("Name", "Ada");
        await s.assertText("Saved");
      });
      expect(calls).toContain('fillIn("Name", "Ada")');
      expect(calls).toContain('assertText("Saved")');
    });

    it("fails, naming the steps, when an async callback leaves steps unawaited", async () => {
      const { driver, calls } = selfScopingDriver();
      const error = await new Session(driver)
        .within("form", async (s) => {
          s.assertText("impossible");
        })
        .run()
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );
      expect(error).toBeInstanceOf(StepError);
      expect(error!.message).toContain("[FAILED] within('form')");
      expect(error!.message).toContain(
        "the callback queued assertText('impossible') but never ran it",
      );
      // Nothing ran silently afterwards either.
      expect(calls).not.toContain('assertText("impossible")');
    });

    it("never puts a typed value in the leftover-steps error or the onStep payload", async () => {
      const SECRET = "fake-secret-value-123";
      const { driver } = selfScopingDriver();
      const failed: unknown[] = [];
      const error = await new Session(driver, {
        onStep: (e) => {
          if (e.status === "failed") failed.push(e.error);
        },
      })
        .within("form", async (s) => {
          s.fillIn("Login code", SECRET);
        })
        .run()
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );
      expect(error!.message).toContain("fillIn('Login code', '••••••')");
      expect(error!.message).not.toContain(SECRET);
      expect(String((failed[0] as Error).message)).not.toContain(SECRET);
    });

    it("never puts a typed value in assertDownload's leftover-steps error", async () => {
      const SECRET = "fake-secret-value-123";
      const { driver } = createMockDriver();
      const error = await new Session(driver)
        .assertDownload("report.csv", async (s) => {
          s.fillIn("Login code", SECRET);
        })
        .run()
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );
      expect(error).toBeInstanceOf(StepError);
      expect(error!.message).not.toContain(SECRET);
    });

    it("assertDownload's trigger is held to the same rule", async () => {
      const { driver } = createMockDriver();
      const error = await new Session(driver)
        .assertDownload("report.csv", async (s) => {
          s.clickLink("Report");
        })
        .run()
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );
      expect(error).toBeInstanceOf(StepError);
      expect(error!.message).toContain("clickLink('Report')");
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

      expect(driver.attachFile).toHaveBeenCalledWith("Avatar", "photo.png", undefined);
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

describe("secrets in failure reports", () => {
  // Obviously fake values: none of these is a real credential.
  const FAKE_SECRET = "fake-secret-value-123";
  const HIDDEN = "••••••";

  /** Run the chain, expect it to fail, and return the StepError. */
  async function failureOf(chain: PromiseLike<void>): Promise<StepError> {
    const error = await Promise.resolve(chain).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StepError);
    return error as StepError;
  }

  /** A driver whose assertPath fails, like the sign-in chain that leaked. */
  function driverFailingAtAssertPath(overrides?: Partial<TestDriver>) {
    return createMockDriver({
      assertPath: vi.fn(async () => {
        throw new Error("expected path '/home', got '/login'");
      }),
      ...overrides,
    }).driver;
  }

  it("hides the value typed into a field whose label looks secret", async () => {
    const session = new Session(driverFailingAtAssertPath());

    const error = await failureOf(
      session
        .visit("/login")
        .fillIn("Username:", "fake-user")
        .fillIn("Password:", FAKE_SECRET)
        .clickButton("Log in")
        .assertPath("/home"),
    );

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain(`[ok] fillIn('Password:', '${HIDDEN}')`);
  });

  it.each([
    "Password",
    "Confirm password",
    "Passcode",
    "Client secret",
    "Access token",
    "API key",
    "api_key",
    "PIN",
    "OTP",
  ])("treats the label %s as secret, whatever its case", async (label) => {
    const session = new Session(driverFailingAtAssertPath());

    const error = await failureOf(
      session.fillIn(label, FAKE_SECRET).assertPath("/home"),
    );

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain(`fillIn('${label}', '${HIDDEN}')`);
  });

  it.each(["Email", "Shipping address", "Pincode", "Footprint"])(
    "does not treat the label %s as secret",
    async (label) => {
      const session = new Session(driverFailingAtAssertPath());

      const error = await failureOf(
        session.fillIn(label, "ordinary value").assertPath("/home"),
      );

      expect(error.message).toContain(`fillIn('${label}', 'ordinary value')`);
    },
  );

  it("hides the value when the driver reports a password field, whatever its label", async () => {
    const driver = driverFailingAtAssertPath({
      lastFilledFieldIsPassword: vi.fn(async () => true),
    });
    const session = new Session(driver);

    const error = await failureOf(
      session.fillIn("Login code", FAKE_SECRET).assertPath("/home"),
    );

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain(`[ok] fillIn('Login code', '${HIDDEN}')`);
  });

  it("hides the value, in the chain and the cause, when filling a password field fails", async () => {
    const driver = createMockDriver({
      fillIn: vi.fn(async (_label: string, value: string) => {
        // Playwright's call log echoes the value like this.
        throw new Error(`locator.fill: Timeout\nCall log:\n  - fill("${value}")`);
      }),
      lastFilledFieldIsPassword: vi.fn(async () => true),
    }).driver;
    const session = new Session(driver);

    const error = await failureOf(session.fillIn("Login code", FAKE_SECRET));

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain(`[FAILED] fillIn('Login code', '${HIDDEN}')`);
    expect(String((error.cause as Error).message)).not.toContain(FAKE_SECRET);
    expect(String((error.cause as Error).stack)).not.toContain(FAKE_SECRET);
  });

  it("hides the value when the driver cannot tell whether the field is a password field", async () => {
    const driver = driverFailingAtAssertPath({
      lastFilledFieldIsPassword: vi.fn(async () => {
        throw new Error("page closed");
      }),
    });
    const session = new Session(driver);

    const error = await failureOf(
      session.fillIn("Login code", FAKE_SECRET).assertPath("/home"),
    );

    expect(error.message).not.toContain(FAKE_SECRET);
  });

  it("hides any value marked sensitive", async () => {
    const session = new Session(driverFailingAtAssertPath());

    const error = await failureOf(
      session
        .fillIn("Recovery phrase", FAKE_SECRET, { sensitive: true })
        .assertPath("/home"),
    );

    expect(error.message).not.toContain(FAKE_SECRET);
    expect(error.message).toContain(`fillIn('Recovery phrase', '${HIDDEN}')`);
  });

  it("still types the real value", async () => {
    const { driver, calls } = createMockDriver();
    const session = new Session(driver);

    await session
      .fillIn("Password", FAKE_SECRET)
      .fillIn("Recovery phrase", FAKE_SECRET, { sensitive: true });

    expect(calls).toEqual([
      `fillIn("Password", "${FAKE_SECRET}")`,
      `fillIn("Recovery phrase", "${FAKE_SECRET}", {"sensitive":true})`,
    ]);
  });

  it("keeps showing ordinary values, which help debugging", async () => {
    const driver = driverFailingAtAssertPath({
      lastFilledFieldIsPassword: vi.fn(async () => false),
    });
    const session = new Session(driver);

    const error = await failureOf(
      session.fillIn("Email", "someone@example.com").assertPath("/home"),
    );

    expect(error.message).toContain(
      "[ok] fillIn('Email', 'someone@example.com')",
    );
  });

  it("hides the value in the step title a driver wraps the step in", async () => {
    const titles: string[] = [];
    const { driver } = createMockDriver();
    driver.wrapStep = vi.fn(async (name: string, fn: () => Promise<void>) => {
      titles.push(name);
      await fn();
    });
    const session = new Session(driver);

    await session
      .fillIn("Email", "someone@example.com")
      .fillIn("Password", FAKE_SECRET)
      .fillIn("Recovery phrase", FAKE_SECRET, { sensitive: true });

    expect(titles).toEqual([
      "fillIn('Email', 'someone@example.com')",
      `fillIn('Password', '${HIDDEN}')`,
      `fillIn('Recovery phrase', '${HIDDEN}')`,
    ]);
  });
});

describe("secrets in step names before a step starts", () => {
  const FAKE_SECRET = "fake-secret-value-123";
  const HIDDEN = "••••••";

  /** A driver that records the name wrapStep sees at start and at end. */
  function recordingDriver(overrides?: Partial<TestDriver>) {
    const names: string[] = [];
    const { driver } = createMockDriver(overrides);
    driver.wrapStep = vi.fn(
      async (
        name: string,
        fn: () => Promise<void>,
        step?: { readonly name: string },
      ) => {
        names.push(`start ${name}`);
        try {
          await fn();
        } finally {
          names.push(`end ${step?.name ?? name}`);
        }
      },
    );
    return { driver, names };
  }

  it("hides the value before the step starts when the field is a password field", async () => {
    const { driver, names } = recordingDriver({
      fieldIsPassword: vi.fn(async () => true),
    });

    await new Session(driver).fillIn("Login code", FAKE_SECRET);

    expect(names).toEqual([
      `start fillIn('Login code', '${HIDDEN}')`,
      `end fillIn('Login code', '${HIDDEN}')`,
    ]);
  });

  it("hands wrapStep the step so a name hidden while running is seen at the end", async () => {
    const { driver, names } = recordingDriver({
      lastFilledFieldIsPassword: vi.fn(async () => true),
    });

    await new Session(driver).fillIn("Login code", FAKE_SECRET);

    expect(names).toEqual([
      `start fillIn('Login code', '${FAKE_SECRET}')`,
      `end fillIn('Login code', '${HIDDEN}')`,
    ]);
  });

  it("hides the value and fails without filling when the field never appears", async () => {
    const fillIn = vi.fn(async () => {});
    const { driver, names } = recordingDriver({
      fillIn,
      fieldIsPassword: vi.fn(async () => {
        throw new Error(`no field labelled 'Login code' (typed ${FAKE_SECRET})`);
      }),
    });

    const error = await new Session(driver)
      .fillIn("Login code", FAKE_SECRET)
      .run()
      .then(
        () => null,
        (e: unknown) => e as StepError,
      );

    expect(error).toBeInstanceOf(StepError);
    expect(error!.message).not.toContain(FAKE_SECRET);
    expect(names.join("\n")).not.toContain(FAKE_SECRET);
    expect(fillIn).not.toHaveBeenCalled();
  });

  it("shows an ordinary value", async () => {
    const { driver, names } = recordingDriver({
      fieldIsPassword: vi.fn(async () => false),
    });

    await new Session(driver).fillIn("Email", "someone@example.com");

    expect(names).toEqual([
      "start fillIn('Email', 'someone@example.com')",
      "end fillIn('Email', 'someone@example.com')",
    ]);
  });
});

describe("steps that never ran keep typed values hidden", () => {
  const SECRET = "fake-secret-value-123";
  const HIDDEN = "••••••";

  it("hides a skipped fillIn's value in the chain", async () => {
    const { driver } = createMockDriver({
      visit: vi.fn(async () => {
        throw new Error("server down");
      }),
    });
    const error = await new Session(driver)
      .visit("/")
      .fillIn("Credential", SECRET)
      .run()
      .then(
        () => null,
        (e: unknown) => e as StepError,
      );
    expect(error).toBeInstanceOf(StepError);
    expect(error!.message).toContain(`[skipped] fillIn('Credential', '${HIDDEN}')`);
    expect(error!.message).not.toContain(SECRET);
  });

  it("hides it in the parent's failed onStep event when the chain is inside within()", async () => {
    const mock = createMockDriver({
      assertText: vi.fn(async () => {
        throw new Error("not there");
      }),
    });
    mock.driver.within = vi.fn(async () => mock.driver);
    const failed: string[] = [];
    const error = await new Session(mock.driver, {
      onStep: (e) => {
        if (e.status === "failed") failed.push(String((e.error as Error).message));
      },
    })
      .within("form", (s) => s.assertText("Nope").fillIn("Credential", SECRET))
      .run()
      .then(
        () => null,
        (e: unknown) => e as StepError,
      );
    expect(error!.message).not.toContain(SECRET);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join("\n")).not.toContain(SECRET);
  });
});

describe("a field that is not there", () => {
  /** A driver whose field lookup fails the way a missing field does. */
  function missingFieldDriver() {
    return createMockDriver({
      fieldIsPassword: vi.fn(async (label: string) => {
        throw new Error(`waiting for getByLabel('${label}')`);
      }),
    }).driver;
  }

  async function failureOf(chain: { run(): Promise<void> }): Promise<StepError> {
    const error = await chain.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StepError);
    return error as StepError;
  }

  it.each([
    ["assertValue", (s: Session) => s.assertValue("What needs to be done?", "")],
    ["fillIn", (s: Session) => s.fillIn("What needs to be done?", "")],
  ] as const)("%s with an empty value shows '' and says the field was not found", async (_verb, chain) => {
    const error = await failureOf(chain(new Session(missingFieldDriver())));
    expect(error.message).toContain(`('What needs to be done?', '')`);
    expect(error.message).not.toContain("••••••");
    expect(error.message).toContain(
      "no field labelled 'What needs to be done?' (or with that placeholder) was found",
    );
  });

  it("a non-empty value stays hidden, and the failure still says the field was not found", async () => {
    const error = await failureOf(
      new Session(missingFieldDriver()).fillIn("Login code", "fake-secret-value-123"),
    );
    expect(error.message).toContain("fillIn('Login code', '••••••')");
    expect(error.message).not.toContain("fake-secret-value-123");
    expect(error.message).toContain("no field labelled 'Login code' (or with that placeholder) was found");
  });

  it("a secret-looking label on a missing field says not found, not 'secret field'", async () => {
    const error = await failureOf(
      new Session(missingFieldDriver()).fillIn("Password", "fake-secret-value-123"),
    );
    expect(error.message).toContain("no field labelled 'Password' (or with that placeholder) was found");
    expect(error.message).not.toContain("fake-secret-value-123");
  });

  it("several matching fields are reported as ambiguous, not as missing", async () => {
    const driver = createMockDriver({
      fieldIsPassword: vi.fn(async () => {
        throw new Error("fillIn('Code'): 2 fields are labelled 'Code'.");
      }),
    }).driver;
    const error = await failureOf(new Session(driver).assertValue("Code", "x"));
    expect(error.message).toContain("assertValue('Code'): 2 fields are labelled 'Code'.");
    expect(error.message).not.toContain("was found");
  });
});

describe("discard()", () => {
  it("drops queued steps that have not started and says how many; awaiting then runs nothing", async () => {
    const { driver, calls } = createMockDriver();
    const session = new Session(driver);
    session.visit("/").clickButton("Go").assertText("Done");
    expect(session.discard()).toBe(3);
    await session;
    expect(calls).toEqual([]);
    expect(session.discard()).toBe(0);
  });

  it("does not touch a chain that is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { driver, calls } = createMockDriver({
      visit: vi.fn(async () => {
        calls.push('visit("/")');
        await gate;
      }),
    });
    const session = new Session(driver);
    const running = session.visit("/").clickButton("Go").run();
    // Queued after the chain started: not part of it.
    session.assertText("Later");
    expect(session.discard()).toBe(1);
    release();
    await running;
    expect(calls).toEqual(['visit("/")', 'clickButton("Go")']);
  });

  it("works on a within() scoped session", async () => {
    const { driver, calls } = createMockDriver();
    driver.within = vi.fn(async () => driver);
    let dropped = -1;
    await new Session(driver).within("form", async (s) => {
      s.fillIn("Name", "x");
      dropped = s.discard();
    });
    expect(dropped).toBe(1);
    expect(calls).toEqual([]);
  });
});
