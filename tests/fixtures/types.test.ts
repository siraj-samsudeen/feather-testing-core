// @vitest-environment node
/**
 * Compile-time checks of the fixture API (type-checked by `npm run lint`
 * through tsconfig.typecheck-tests.json), run once as ordinary tests too.
 */
import { describe, expect, it } from "vitest";
import { defineTest, value, type Runner } from "../../src/fixtures/index.js";

const registered: string[] = [];
const runner: Runner = {
  test: (name) => void registered.push(name),
  afterAll: () => undefined,
};

type Handler = (request: Request) => Response;

const test = defineTest<{ greeting: string; handler: Handler; shout: string }>(runner, {
  greeting: "hi",
  handler: value((_request: Request) => new Response("ok")),
  shout: async ({ greeting }, use) => {
    await use(greeting.toUpperCase());
  },
});

const optional = defineTest<{ maybeHandler: Handler | undefined }>(runner, {
  maybeHandler: undefined,
});

describe("fixture API types", () => {
  it("accept values, fixture functions, [fn, options] and value(x) in .with()", () => {
    test.with({ greeting: "hello" })("a value", async ({ greeting }) => void greeting.length);
    test.with({ greeting: async ({}, use) => use("from a fixture function") })("a fixture fn", async ({ shout }) =>
      void shout.length,
    );
    test.with({ greeting: [async ({}, use) => use("with options"), { scope: "file" }] })("[fn, options]", async ({
      greeting,
    }) => void greeting);
    test.with({ handler: value((_request: Request) => new Response("other")) })("value(fn)", async ({ handler }) =>
      void handler,
    );
    // @ts-expect-error -- not a defined fixture
    expect(() => test.with({ greting: "typo" })).toThrow("is not a defined fixture");
    // @ts-expect-error -- wrong type for greeting
    test.with({ greeting: 42 });
    // @ts-expect-error -- [x, { value: true }] is for functions; use value(x) or the plain value
    test.with({ greeting: ["hello", { value: true }] });
    // @ts-expect-error -- likewise for a number
    test.with({ greeting: [42, { value: true }] });
    test.with({ handler: [(_r: Request) => new Response("ok"), { value: true }] });
    // @ts-expect-error -- a string fixture cannot be [fn, { value: true }]: that would make the function its value
    test.with({ greeting: [async ({}, use) => use("x"), { value: true }] });
    // [fn, { scope }] keeps its contextual typing (no implicit any)
    test.with({ greeting: [async ({ shout }, use) => use(shout.toLowerCase()), { scope: "test" }] });
    // An optional function fixture takes [fn, { value: true }] too.
    optional.with({ maybeHandler: [(_r: Request) => new Response("ok"), { value: true }] });
    expect(registered).toEqual(["a value", "a fixture fn", "[fn, options]", "value(fn)"]);
    expect(typeof optional).toBe("function");
  });

  it("take a two-item array value as the value: [1, {}], rows", () => {
    const pairs = defineTest<{ pair: [number, {}]; rows: { id: number }[] }>(runner, {
      pair: [1, {}],
      rows: [{ id: 1 }, { id: 2 }],
    });
    pairs.with({ pair: [2, {}], rows: [{ id: 3 }, { id: 4 }] })("pairs", async ({ pair, rows }) => {
      const n: number = pair[0] + rows[1]!.id;
      void n;
    });
    // @ts-expect-error -- an unknown option key: not [fn, options], and not a string either
    test.with({ greeting: [async ({}, use) => use("x"), { scope: "file", limit: 3 }] });
    expect(registered).toContain("pairs");
  });

  it("type a test body's fixtures", () => {
    test("typed", async ({ greeting, shout }) => {
      const both: string = greeting + shout;
      void both;
    });
    // @ts-expect-error -- 'missing' is not a fixture
    test("untyped name", async ({ missing }) => void missing);
    expect(registered).toContain("typed");
  });
});
