/**
 * `feather-testing-core/fixtures`: the fixture engine (defineTest) and
 * core's own fixtures — browser, context, page, session, request, rtl.
 *
 *   import { test as bunTest, afterAll } from "bun:test";
 *   import { defineCoreTest } from "feather-testing-core/fixtures";
 *
 *   export const test = defineCoreTest({ test: bunTest, afterAll }).extend({
 *     baseUrl: async ({}, use) => { const app = startApp(); await use(app.url); app.stop(); },
 *   });
 *
 *   test("adds a to-do", async ({ session }) => {
 *     await session.visit("/").fillIn("What needs to be done?", "Buy milk").submit();
 *   });
 *
 * Adapters are loaded only when a test asks for their fixture, so a test
 * that only uses `request` never loads or launches a browser.
 */
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Session } from "../session.js";
import type { PlaywrightStepContext } from "../playwright/driver.js";
import type { RequestHandler } from "../request/browser.js";
import type { RequestPage, RequestStepContext } from "../request/driver.js";
import type { RTLQueries, RTLStepContext } from "../rtl/driver.js";
import {
  defineTest,
  type DefineTestOptions,
  type FixtureDefs,
  type Runner,
  type TestFn,
} from "./engine.js";

export {
  DEFAULT_TEARDOWN_TIMEOUT,
  DEFAULT_TEST_TIMEOUT,
  defineTest,
  destructuredNames,
  type DefineTestOptions,
  type FixtureDef,
  type FixtureDefs,
  type FixtureFn,
  type FixtureOptions,
  type FixtureScope,
  type Runner,
  type TestBody,
  type TestFn,
  type TestInfo,
  type Use,
} from "./engine.js";

export type { SessionCookie } from "../types.js";

/** Per-test timeout when the browser is headed (slowMo makes tests slow). */
export const HEADED_TEST_TIMEOUT = 120_000;

export interface CoreFixtures {
  /** Option: which browser to launch. Default "chromium". */
  browserName: "chromium" | "firefox" | "webkit";
  /** Option: a visible browser. Default: HEADED=1 in the environment. */
  headed: boolean;
  /** Option: ms between browser actions. Default: 700 when headed, else 0. */
  slowMo: number;
  /**
   * Option: record a video of every page and a screenshot of the last page.
   * Default: "on" with RECORD=1 in the environment, else "off".
   * "on-failure" keeps them only for failed tests.
   */
  record: "off" | "on" | "on-failure";
  /** Option: where recordings go ("videos/", "screenshots/"). Default "test-results". */
  outputDir: string;
  /** Supplied by the consumer (or a layered package): the app's base URL, for `session`. */
  baseUrl: string;
  /** Supplied by the consumer (or a layered package): the app's request handler, for `request`. */
  handler: RequestHandler;
  /** The browser, launched once per file. */
  browser: Browser;
  /** A fresh browser context per test (cookies, storage), recorded if `record` says so. */
  context: BrowserContext;
  /** A page in the test's context. */
  page: Page;
  /** A Playwright-adapter session on `page`, with `baseUrl`. */
  session: Session<PlaywrightStepContext, Page>;
  /** A request-adapter session on `handler` (no browser). */
  request: Session<RequestStepContext, RequestPage>;
  /** An RTL-adapter session on what is rendered in document.body. */
  rtl: Session<RTLStepContext, RTLQueries>;
}

/** "adds a to-do: twice" → "adds-a-to-do-twice", for recording file names. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Core's fixtures, for defineTest(runner, coreFixtures) or defineCoreTest(runner). */
export function coreFixtures(): FixtureDefs<CoreFixtures, CoreFixtures> {
  const recordFromEnv = process.env.RECORD === "1" ? "on" : "off";
  const fixtures: Partial<FixtureDefs<CoreFixtures, CoreFixtures>> = {
    browserName: "chromium",
    headed: process.env.HEADED === "1",
    slowMo: [
      async ({ headed }, use) => {
        await use(headed ? 700 : 0);
      },
      { scope: "file" },
    ],
    record: recordFromEnv,
    outputDir: "test-results",

    browser: [
      async ({ browserName, headed, slowMo }, use) => {
        const playwright = await import("playwright");
        const browser = await playwright[browserName].launch({ headless: !headed, slowMo });
        try {
          await use(browser);
        } finally {
          await browser.close();
        }
      },
      { scope: "file" },
    ],

    context: async ({ browser, record, outputDir }, use, info) => {
      const recording = record !== "off";
      const context = await browser.newContext(
        recording ? { recordVideo: { dir: join(outputDir, "videos") } } : {},
      );
      try {
        await use(context);
      } finally {
        const keep = record === "on" || (record === "on-failure" && info.status === "failed");
        const pages = context.pages();
        const last = pages.at(-1);
        if (keep && last && !last.isClosed()) {
          const dir = join(outputDir, "screenshots");
          await mkdir(dir, { recursive: true });
          await last.screenshot({ path: join(dir, `${slug(info.title)}.png`) });
        }
        const videos = pages.map((page) => page.video()).filter((video) => video !== null);
        await context.close();
        if (recording && !keep) {
          for (const video of videos) {
            await unlink(await video.path()).catch(() => undefined); // already gone: nothing to remove
          }
        }
      }
    },

    page: async ({ context }, use) => {
      await use(await context.newPage());
    },

    session: async ({ page, baseUrl }, use) => {
      const { createSession } = await import("../playwright/index.js");
      await use(createSession(page, { baseUrl }));
    },

    request: async ({ handler }, use) => {
      const { createSession } = await import("../request/index.js");
      await use(createSession(handler));
    },

    rtl: async ({}, use) => {
      const { createSession } = await import("../rtl/index.js");
      await use(createSession());
    },
  };
  return fixtures as FixtureDefs<CoreFixtures, CoreFixtures>;
}

/**
 * defineTest(runner, coreFixtures()), with a longer per-test timeout when
 * headed. Supply `baseUrl` (for `session`) and `handler` (for `request`)
 * with .extend() or .with(); a test that never asks for them never needs them.
 */
export function defineCoreTest(
  runner: Runner,
  settings: Omit<DefineTestOptions<CoreFixtures>, "timeout"> = {},
): TestFn<CoreFixtures> {
  return defineTest<CoreFixtures>(runner, coreFixtures(), {
    ...settings,
    timeout: (options) => (options.headed === true ? HEADED_TEST_TIMEOUT : undefined),
  });
}
