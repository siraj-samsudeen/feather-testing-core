import { test, expect } from "./fixtures.js";
import { PlaywrightDriver } from "../../src/playwright/driver.js";
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

  test.describe("assertPath() / refutePath()", () => {
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
      expect(scoped).toBeDefined();
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
