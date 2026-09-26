import { test, expect } from "./fixtures.js";
import { PlaywrightDriver } from "../../src/playwright/driver.js";
import { Session } from "../../src/session.js";
import { StepError } from "../../src/errors.js";
import type { TestDriver } from "../../src/types.js";

test.describe("PlaywrightDriver", () => {
  test.describe("visit()", () => {
    test("navigates to a URL", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await expect(page.locator("h1")).toHaveText("Home");
    });

    test("navigates to different pages", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/about");
      await expect(page.locator("h1")).toHaveText("About");
    });
  });

  test.describe("click()", () => {
    test("finds and clicks an element by text", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await driver.click("Click me");
      await expect(page.locator("#msg")).toHaveText("Clicked!");
    });
  });

  test.describe("clickLink()", () => {
    test("clicks a link by accessible name", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await driver.clickLink("About");
      await expect(page.locator("h1")).toHaveText("About");
    });
  });

  test.describe("clickButton()", () => {
    test("clicks a button by accessible name", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await driver.clickButton("Click me");
      await expect(page.locator("#msg")).toHaveText("Clicked!");
    });
  });

  test.describe("fillIn()", () => {
    test("fills an input by label", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Name", "Alice");
      await expect(page.getByLabel("Name")).toHaveValue("Alice");
    });

    test("falls back to placeholder when label not found", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Nickname", "Ali");
      await expect(page.getByPlaceholder("Nickname")).toHaveValue("Ali");
    });

    test("replaces existing value", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Name", "Alice");
      await driver.fillIn("Name", "Bob");
      await expect(page.getByLabel("Name")).toHaveValue("Bob");
    });

    test("waits for an async-rendered labeled field", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/delayed-field");
      // Field appears 300ms after load; .or() auto-waits instead of
      // falling through to the placeholder branch.
      await driver.fillIn("Late Field", "made it");
      await expect(page.getByLabel("Late Field")).toHaveValue("made it");
    });
  });

  test.describe("selectOption()", () => {
    test("selects a dropdown option by visible label text", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.selectOption("Favorite Color", "Blue");
      await expect(page.getByLabel("Favorite Color")).toHaveValue("b");
    });
  });

  test.describe("check() / uncheck()", () => {
    test("checks an unchecked checkbox", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.check("Subscribe to newsletter");
      await expect(page.getByLabel("Subscribe to newsletter")).toBeChecked();
    });

    test("does not uncheck an already checked checkbox when check() is called", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      // "Receive ads" is checked by default
      await driver.check("Receive ads");
      await expect(page.getByLabel("Receive ads")).toBeChecked();
    });

    test("unchecks a checked checkbox", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.uncheck("Receive ads");
      await expect(page.getByLabel("Receive ads")).not.toBeChecked();
    });
  });

  test.describe("choose()", () => {
    test("selects a radio button by label", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.choose("Pro");
      await expect(
        page.getByRole("radio", { name: "Pro" }),
      ).toBeChecked();
    });
  });

  test.describe("submit()", () => {
    test("finds submit button by accessible name containing 'submit'", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/submit-by-name");
      await driver.fillIn("Value", "test");
      await driver.submit();
      await expect(page.locator("#r")).toHaveText("Done!");
    });

    test("finds submit button by type='submit'", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/submit-by-type");
      await driver.fillIn("Value", "test");
      await driver.submit();
      await expect(page.locator("#r")).toHaveText("Done!");
    });

    test("falls back to pressing Enter when no submit button", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/submit-enter");
      await driver.fillIn("Value", "test");
      await driver.submit();
      await expect(page.locator("#r")).toHaveText("Done!");
    });

    test("throws when no form was previously interacted with", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await expect(driver.submit()).rejects.toThrow(
        "submit() called but no form was previously interacted with",
      );
    });

    test("prefers type='submit' over accessible name containing 'submit'", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/submit-precedence");
      await driver.fillIn("Value", "test");
      await driver.submit();
      await expect(page.locator("#r")).toHaveText("Saved!");
    });
  });

  test.describe("upload()", () => {
    test("sets a file input by label", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/upload");
      await driver.upload("Avatar", "package.json");
      await expect(page.locator("#uploaded")).toContainText(
        "Uploaded: package.json",
      );
    });
  });

  test.describe("dropFile()", () => {
    test("dispatches a DataTransfer drop on a selector", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/upload");
      await driver.dropFile("#dropzone", "package.json");
      await expect(page.locator("#dropped")).toContainText(
        "Dropped: package.json",
      );
      // Real file content was transferred, not an empty placeholder
      await expect(page.locator("#dropped")).not.toContainText("(0 bytes)");
    });
  });

  test.describe("assertText() / refuteText()", () => {
    test("assertText passes when text is visible", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await driver.assertText("Welcome to the home page");
    });

    test("assertText fails when text is not present", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await expect(driver.assertText("Nonexistent text")).rejects.toThrow();
    });

    test("refuteText passes when text is not present", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await driver.refuteText("Nonexistent text");
    });

    test("refuteText fails when text is visible", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      await expect(
        driver.refuteText("Welcome to the home page"),
      ).rejects.toThrow();
    });
  });

  test.describe("assertExactText()", () => {
    test("compares the current scope's whole text, not a numeric prefix", async ({
      page,
    }) => {
      await page.setContent('<div class="total">Total: 10</div>');
      const scoped = await new PlaywrightDriver(page).within(".total");

      const error = await scoped
        .assertExactText("Total: 1", { timeout: 100 })
        .then(
          () => null,
          (cause: unknown) => cause as Error,
        );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("toHaveText");
      expect(error?.message).toContain("locator('.total')");
      expect(error?.message).toContain("Total: 1");
      expect(error?.message).toContain("Total: 10");
      await scoped.assertExactText("Total: 10");
    });

    test("rejects extra surrounding text and preserves case", async ({ page }) => {
      await page.setContent('<div class="total">Prefix Total: 1 suffix</div>');
      const scoped = await new PlaywrightDriver(page).within(".total");

      await expect(
        scoped.assertExactText("Total: 1", { timeout: 100 }),
      ).rejects.toThrow();
      await expect(
        scoped.assertExactText("prefix total: 1 suffix", { timeout: 100 }),
      ).rejects.toThrow();
    });

    test("normalizes whitespace on both sides", async ({ page }) => {
      await page.setContent(
        '<div class="total">\n  Total: <strong>1</strong>\t </div>',
      );
      const scoped = await new PlaywrightDriver(page).within(".total");

      await scoped.assertExactText("  Total:   1  ");
    });

    test("uses only the current scope", async ({ page }) => {
      await page.setContent(`
        <section class="summary"><div class="total">Total: 10</div></section>
        <aside><div class="total">Total: 1</div></aside>
      `);
      const summary = await new PlaywrightDriver(page).within(".summary");
      const total = await summary.within(".total");

      await expect(
        total.assertExactText("Total: 1", { timeout: 100 }),
      ).rejects.toThrow();
    });

    test("retries until the scoped element's text is equal", async ({ page }) => {
      await page.setContent('<div class="total">Total: 10</div>');
      await page.locator(".total").evaluate((element) => {
        setTimeout(() => {
          element.textContent = "Total: 1";
        }, 100);
      });
      const scoped = await new PlaywrightDriver(page).within(".total");

      await scoped.assertExactText("Total: 1", { timeout: 1_000 });
    });
  });

  test.describe("assertHas() / refuteHas()", () => {
    test("assertHas passes when element exists", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await driver.assertHas("li.item");
    });

    test("assertHas with count", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await driver.assertHas("li.item", { count: 3 });
    });

    test("assertHas with count fails on wrong count", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await expect(
        driver.assertHas("li.item", { count: 5, timeout: 1000 }),
      ).rejects.toThrow();
    });

    test("assertHas with text filter", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await driver.assertHas(".card", { text: "Overdue" });
    });

    test("assertHas with text and count", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      // Only one card contains "Overdue"
      await driver.assertHas(".card", { text: "Overdue", count: 1 });
    });

    test("assertHas with exact text", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      // "task" as regex matches all 3 cards
      await driver.assertHas(".card", { text: "task", count: 3 });
      // "task" as exact substring also matches all 3
      await driver.assertHas(".card", {
        text: "task",
        exact: true,
        count: 3,
      });
    });

    test("assertHas fails when element not found", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await expect(
        driver.assertHas(".nonexistent", { timeout: 1000 }),
      ).rejects.toThrow();
    });

    test("refuteHas passes when element does not exist", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await driver.refuteHas(".nonexistent");
    });

    test("refuteHas fails when element exists", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      await expect(
        driver.refuteHas("li.item", { timeout: 1000 }),
      ).rejects.toThrow();
    });

    test("refuteHas with text filter", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      // No card with text "Deleted"
      await driver.refuteHas(".card", { text: "Deleted" });
    });

    test("refuteHas respects exact option", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/multi");
      // "Important" as regex matches the card with "Important task"
      await expect(
        driver.refuteHas(".card", {
          text: "Important",
          exact: false,
          timeout: 1000,
        }),
      ).rejects.toThrow();
    });
  });

  test.describe("form-state assertions", () => {
    test("assertValue passes for a filled labeled input", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Name", "Alice");
      await driver.assertValue("Name", "Alice");
    });

    test("assertValue works with placeholder fields", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Nickname", "Ali");
      await driver.assertValue("Nickname", "Ali");
    });

    test("assertValue fails on wrong value", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.fillIn("Name", "Alice");
      await expect(driver.assertValue("Name", "Bob")).rejects.toThrow();
    });

    test("assertChecked passes for a checked checkbox", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.assertChecked("Receive ads");
    });

    test("assertChecked fails for an unchecked checkbox", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await expect(
        driver.assertChecked("Subscribe to newsletter"),
      ).rejects.toThrow();
    });

    test("refuteChecked passes for an unchecked checkbox", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.refuteChecked("Subscribe to newsletter");
    });

    test("refuteChecked fails for a checked checkbox", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await expect(driver.refuteChecked("Receive ads")).rejects.toThrow();
    });

    test("assertSelected passes for the selected option label", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.selectOption("Favorite Color", "Blue");
      await driver.assertSelected("Favorite Color", "Blue");
    });

    test("assertSelected fails for a non-selected option", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.selectOption("Favorite Color", "Blue");
      await expect(
        driver.assertSelected("Favorite Color", "Red"),
      ).rejects.toThrow();
    });

    test("assertOptions passes when the select offers exactly these options", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await driver.assertOptions("Favorite Color", [
        "--Select--",
        "Red",
        "Green",
        "Blue",
      ]);
    });

    test("assertOptions fails when an option is missing from the expectation", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/form");
      await expect(
        driver.assertOptions("Favorite Color", ["Red", "Green", "Blue"]),
      ).rejects.toThrow();
    });
  });

  test.describe("assertPath() / refutePath()", () => {
    test("assertPath does not match a path suffix", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/re/import");
      await driver.assertPath("/re/import");
      await expect(driver.assertPath("/import")).rejects.toThrow();
    });

    test("refutePath passes on a path suffix of the current path", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/re/import");
      await driver.refutePath("/import");
    });

    test("assertPath passes when on the correct path", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/about");
      await driver.assertPath("/about");
    });

    test("assertPath fails when on wrong path", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/about");
      await expect(driver.assertPath("/form")).rejects.toThrow();
    });

    test("assertPath ignores query params by default", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/search?q=hello");
      await driver.assertPath("/search");
    });

    test("assertPath with queryParams", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/search?q=hello&page=1");
      await driver.assertPath("/search", {
        queryParams: { q: "hello", page: "1" },
      });
    });

    test("refutePath passes when not on the path", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/about");
      await driver.refutePath("/form");
    });

    test("refutePath fails when on the path", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/about");
      await expect(driver.refutePath("/about")).rejects.toThrow();
    });
  });

  test.describe("within()", () => {
    test("scopes actions to a container element", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/scoped");

      const scoped = await driver.within(".sidebar");
      await scoped.assertText("Sidebar content");
      await scoped.clickButton("Sidebar Button");
    });

    test("scoped driver cannot see elements outside container", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/scoped");

      const scoped = await driver.within(".sidebar");
      await expect(scoped.assertText("Main content")).rejects.toThrow();
    });

    test("returns a TestDriver (can be used as a driver)", async ({
      page,
    }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/scoped");

      const scoped: TestDriver = await driver.within(".sidebar");
      // A driver, not just something: it answers the DSL's own questions.
      await scoped.assertText("Sidebar content");
      await expect(scoped.assertText("Main content")).rejects.toThrow();
    });
  });

  test.describe("debug()", () => {
    test("takes a screenshot without throwing", async ({ page }) => {
      const driver = new PlaywrightDriver(page);
      await driver.visit("/");
      // Just verify it doesn't throw
      await driver.debug();
    });
  });
});

/**
 * Playwright's bare-string name/label/text matchers are case-insensitive
 * SUBSTRING matchers, so before exact addressing a verb aimed at "Check" also
 * matched a sidebar chip named "Checklist Run — checklist" and the run died on
 * a strict-mode violation — visible only when both happened to be on screen,
 * which made it an ordering-dependent flake rather than an honest failure.
 */
test.describe("exact addressing", () => {
  // Bound the wait for the deliberately-unfindable cases: without it a
  // missing element burns the whole test timeout before failing.
  test.use({ actionTimeout: 2000 });

  test("clickButton picks the exactly-named button over a longer-named one", async ({
    page,
  }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    await driver.clickButton("Check");
    await expect(page.locator("#msg")).toHaveText("Checked!");
  });

  test("clickButton fails clearly when no button matches exactly", async ({
    page,
  }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    // "Chec" is a substring of both buttons and the exact name of neither:
    // a plain not-found, never a strict-mode violation.
    const error = await driver.clickButton("Chec").catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("name: 'Chec', exact: true");
    expect(error.message).not.toContain("strict mode violation");
  });

  test("a failed exact lookup still reports the whole chain", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    const error = await session
      .visit("/collision")
      .clickButton("Chec")
      .assertText("Checked!")
      .then(
        () => null,
        (e: unknown) => e as StepError,
      );
    expect(error).toBeInstanceOf(StepError);
    expect(error!.message).toContain("[ok] visit('/collision')");
    expect(error!.message).toContain(">>> [FAILED] clickButton('Chec')");
    expect(error!.message).toContain("[skipped] assertText('Checked!')");
  });

  test("clickLink picks the exactly-named link", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    await driver.clickLink("About");
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("fillIn picks the exactly-labelled field", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    await driver.fillIn("Name", "Alice");
    await expect(page.locator("#who")).toHaveValue("Alice");
    await expect(page.locator("#company")).toHaveValue("");
  });

  test("click picks the element whose text matches exactly", async ({
    page,
  }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    await driver.click("Check");
    await expect(page.locator("#msg")).toHaveText("Checked!");
  });

  test("assertText stays a substring check", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/collision");
    // Assertions ask "does this text appear", not "is this the whole name".
    await driver.assertText("Checklist Run");
  });
});

test.describe("Session with PlaywrightDriver", () => {
  test("step() receives the page and scope", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/form")
      .step("fill name directly", async ({ page: p, scope }) => {
        expect(scope).toBe(p);
        await p.getByLabel("Name").fill("via step");
      })
      .assertValue("Name", "via step");
  });

  test("failed step() shows its name in StepError", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    try {
      await session.visit("/form").step("explode", async () => {
        throw new Error("boom");
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      expect((e as StepError).message).toContain(
        ">>> [FAILED] step('explode')",
      );
      expect((e as StepError).message).toContain("Cause: boom");
    }
  });

  test("StepError includes steps from earlier chains", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session.visit("/form").fillIn("Name", "Alice");

    try {
      await session.assertText("Nonexistent text");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as StepError).message;
      expect(msg).toContain("[ok] visit('/form')");
      expect(msg).toContain("[ok] fillIn('Name', 'Alice')");
      expect(msg).toContain(">>> [FAILED] assertText('Nonexistent text')");
    }
  });
});

test.describe("until()", () => {
  test("polls a page condition until it holds", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/eventual");

    await driver.until("the job reports done", ({ page: p }) =>
      p.evaluate(() => (window as unknown as Record<string, unknown>).__jobDone),
    );

    await expect(page.locator("#status")).toHaveText("Ready");
  });

  test("accepts a sync predicate over the scope", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/eventual");

    await driver.until(
      "the status reads Ready",
      async ({ scope }) =>
        (await scope.locator("#status").textContent()) === "Ready",
    );
  });

  test("timeout names the awaited condition in the chain trace", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));

    try {
      await session
        .visit("/eventual")
        .until("the job reports failure", () => false, { timeout: 500 })
        .assertText("Ready");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      const msg = (e as StepError).message;
      expect(msg).toContain("[ok] visit('/eventual')");
      expect(msg).toContain(">>> [FAILED] until: the job reports failure");
      expect(msg).toContain("[skipped] assertText('Ready')");
    }
  });

  test("a within()-scoped until sees only the scoped subtree", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/scoped")
      .within(".main", (s) =>
        s.until(
          "the main panel is rendered",
          async ({ scope }) =>
            (await scope.getByText("Main content").count()) === 1 &&
            (await scope.getByText("Sidebar content").count()) === 0,
        ),
      );
  });
});

test.describe("new verbs", () => {
  test("attachFile sets a file input found by label", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/upload");
    await driver.attachFile("Avatar", "tests/playwright/fixtures.ts");
    await expect(page.locator("#uploaded")).toContainText(
      "Uploaded: fixtures.ts",
    );
  });

  test("upload stays as the deprecated alias", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/upload");
    await driver.upload("Avatar", "tests/playwright/fixtures.ts");
    await expect(page.locator("#uploaded")).toContainText(
      "Uploaded: fixtures.ts",
    );
  });

  test("pressKey presses a named key on the focused control", async ({
    page,
  }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/keys");
    await driver.fillIn("Command", "ls");
    // fillIn() sets the value outright rather than typing it, so the only
    // keydown the page ever sees is the one pressKey() sends.
    await driver.pressKey("Enter");
    await expect(page.locator("#keys")).toHaveText("Keys: Enter");
  });

  test("pressKey presses a modifier combination", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/keys");
    await driver.fillIn("Command", "");
    await driver.pressKey("Control+a");
    await expect(page.locator("#keys")).toContainText("Control+a");
  });

  test("hover hovers the element with this text", async ({ page }) => {
    const driver = new PlaywrightDriver(page);
    await driver.visit("/hover");
    await driver.hover("Total");
    await expect(page.locator("#tooltip")).toHaveText("Tooltip: 42 items");
  });

  test("assertDownload passes when the trigger starts the named download", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/download")
      .assertDownload("report.csv", (s) => s.clickButton("Export"))
      .assertText("Exports");
  });

  test("assertDownload accepts a regex filename", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/download")
      .assertDownload(/^report\.\w+$/, (s) => s.clickButton("Export"));
  });

  test("assertDownload fails, named, when the file is not the expected one", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    try {
      await session
        .visit("/download")
        .assertDownload("invoice.pdf", (s) => s.clickButton("Export"));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      const msg = (e as StepError).message;
      expect(msg).toContain(">>> [FAILED] assertDownload('invoice.pdf')");
      expect(msg).toContain("offered a download named 'report.csv'");
    }
  });

  test("assertDownload fails when no download starts", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    try {
      await session
        .visit("/download")
        .assertDownload("report.csv", (s) => s.clickButton("Do nothing"), {
          timeout: 1000,
        });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      expect((e as StepError).message).toContain(
        ">>> [FAILED] assertDownload('report.csv')",
      );
    }
  });
});

test.describe("raw()", () => {
  test("hands the page to the callback and stays in the chain", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/form")
      .raw("type into the name field directly", async (p) => {
        await p.getByLabel("Name").fill("via raw");
      })
      .assertValue("Name", "via raw");
  });

  test("a failed raw step names its label in the chain trace", async ({
    page,
  }) => {
    const session = new Session(new PlaywrightDriver(page));
    try {
      await session
        .visit("/form")
        .raw("drag the card to Done", async () => {
          throw new Error("drag failed");
        })
        .assertText("Done (1)");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      const msg = (e as StepError).message;
      expect(msg).toContain("[ok] visit('/form')");
      expect(msg).toContain(">>> [FAILED] raw('drag the card to Done')");
      expect(msg).toContain("[skipped] assertText('Done (1)')");
      expect(msg).toContain("Cause: drag failed");
    }
  });

  test("raw hands over the page even inside within()", async ({ page }) => {
    const session = new Session(new PlaywrightDriver(page));
    await session
      .visit("/scoped")
      .within(".main", (s) =>
        s.raw("read the sidebar the DSL scoped away", async (p) => {
          expect(await p.locator(".sidebar p").textContent()).toBe(
            "Sidebar content",
          );
        }),
      );
  });
});
