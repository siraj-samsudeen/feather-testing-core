/**
 * A bun:test stand-in for the Playwright Test fixtures in fixtures.ts, so
 * playwright-driver.spec.ts runs unchanged under `bun test`: Playwright is
 * used as a library, one browser per file and a fresh context per test, with
 * every request answered from the same page table.
 */
import { afterAll, beforeAll, describe, test as bunTest } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { routePages } from "./pages.js";

interface Fixtures {
  page: Page;
  context: BrowserContext;
}
interface UseOptions {
  actionTimeout?: number;
}

let browser: Browser | undefined;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** test.use() options of the describe block being collected. */
let currentUse: UseOptions = {};

async function withFixtures(
  use: UseOptions,
  body: (fixtures: Fixtures) => Promise<void>,
): Promise<void> {
  if (!browser) throw new Error("bun-fixtures: the browser did not launch");
  const context = await browser.newContext({
    baseURL: "http://testapp.local",
  });
  if (use.actionTimeout !== undefined) {
    context.setDefaultTimeout(use.actionTimeout);
  }
  await routePages(context);
  const page = await context.newPage();
  try {
    await body({ page, context });
  } finally {
    await context.close();
  }
}

export const test = Object.assign(
  (name: string, body: (fixtures: Fixtures) => Promise<void>) => {
    const use = currentUse;
    // Explicit: Bun 1.4.2 ignores bunfig's [test] timeout.
    bunTest(name, () => withFixtures(use, body), 20_000);
  },
  {
    describe(name: string, fn: () => void) {
      describe(name, () => {
        const outer = currentUse;
        currentUse = { ...outer };
        try {
          fn();
        } finally {
          currentUse = outer;
        }
      });
    },
    /** Each test above already gets an explicit 20 s limit; nothing to do. */
    setTimeout(_ms: number) {},
    use(options: UseOptions) {
      currentUse = { ...currentUse, ...options };
    },
  },
);
