// @vitest-environment node
/** session without a baseUrl fixture: paths resolve against the context's baseURL. */
import { afterAll, test as runnerTest } from "vitest";
import { defineCoreTest } from "../../src/fixtures/index.js";
import { createFixtureApp } from "../request/fixture-app.js";
import { serve } from "../contract/drivers.js";

const test = defineCoreTest({ test: runnerTest, afterAll }).extend({
  server: [
    async ({}, use: (v: string) => Promise<void>) => {
      const server = await serve(createFixtureApp().handle);
      await use(server.url);
      await server.close();
    },
    { scope: "file" },
  ],
  context: async ({ browser, server }, use) => {
    const context = await browser.newContext({ baseURL: server });
    await use(context);
    await context.close();
  },
});

test("no baseUrl fixture: session.visit('/about') uses the context's baseURL", async ({ session }) => {
  await session.visit("/about").assertText("About");
});
