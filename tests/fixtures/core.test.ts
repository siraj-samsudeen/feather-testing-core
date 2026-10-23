// @vitest-environment node
/**
 * Core's fixtures under a real runner (bun:test, or Vitest): lazy creation,
 * file-scoped browser reuse, options and recordings.
 */
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test as runnerTest, vi } from "vitest";
import { chromium } from "playwright";
import { defineCoreTest } from "../../src/fixtures/index.js";
import { createFixtureApp } from "../request/fixture-app.js";
import { serve } from "../contract/drivers.js";

const launch = vi.spyOn(chromium, "launch");
const outputs = join(tmpdir(), `feather-fixtures-${process.pid}-${Date.now()}`);

const test = defineCoreTest({ test: runnerTest, afterAll }).extend({
  handler: async ({}, use) => {
    await use(createFixtureApp().handle);
  },
  baseUrl: [
    async ({}, use) => {
      const server = await serve(createFixtureApp().handle);
      await use(server.url);
      await server.close();
    },
    { scope: "file" },
  ],
});

afterAll(async () => {
  await rm(outputs, { recursive: true, force: true });
});

test("a test asking only for request never launches a browser", async ({ request }) => {
  await request.visit("/about").assertText("About");
  expect(launch).not.toHaveBeenCalled();
});

test("options resolve without launching anything: slowMo follows headed", async ({ slowMo, headed }) => {
  expect(headed).toBe(process.env.HEADED === "1");
  expect(slowMo).toBe(headed ? 700 : 0);
  expect(launch).not.toHaveBeenCalled();
});

test.with({ headed: true })("headed → slowMo 700 (still no browser here)", async ({ slowMo }) => {
  expect(slowMo).toBe(700);
  expect(launch).not.toHaveBeenCalled();
});

test("session drives a browser page at baseUrl", async ({ session }) => {
  await session.visit("/about").assertText("About").clickLink("Back to todos").assertPath("/");
  expect(launch).toHaveBeenCalledTimes(1);
});

test("the browser is launched once per file; each test gets a fresh context", async ({ session, context }) => {
  await session.visit("/login").fillIn("Email", "a@b.c").clickButton("Sign in");
  expect(context.pages()).toHaveLength(1);
  expect(launch).toHaveBeenCalledTimes(1);
});

test("a new test does not see the previous test's cookies", async ({ session }) => {
  await session.visit("/dashboard").assertPath("/login");
});

test.with({ record: "on", outputDir: join(outputs, "on") })(
  "record on: a video and a last-page screenshot",
  async ({ session }) => {
    await session.visit("/about").assertText("About");
  },
);

test.with({ record: "on-failure", outputDir: join(outputs, "on-failure") })(
  "record on-failure: a passing test keeps nothing",
  async ({ session }) => {
    await session.visit("/about").assertText("About");
  },
);

test("recordings were written (record on) and discarded (on-failure, passed)", async ({}) => {
  const on = join(outputs, "on");
  expect((await readdir(join(on, "videos"))).filter((f) => f.endsWith(".webm"))).toHaveLength(1);
  expect(await readdir(join(on, "screenshots"))).toEqual([
    "record-on-a-video-and-a-last-page-screenshot.png",
  ]);
  const onFailure = join(outputs, "on-failure");
  const videos = await readdir(join(onFailure, "videos")).catch(() => [] as string[]);
  expect(videos.filter((f) => f.endsWith(".webm"))).toHaveLength(0);
  const shots = await readdir(join(onFailure, "screenshots")).catch(() => [] as string[]);
  expect(shots).toHaveLength(0);
});
