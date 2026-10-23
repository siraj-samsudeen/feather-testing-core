/**
 * The two drivers the DSL contract runs against, behind one shape: give it
 * the fixture app's extra pages, get back sessions and a cleanup.
 *
 * - request: the request adapter over the fixture app's handler, in-process.
 * - playwright: a real Chromium (Playwright as a library, no runner) on the
 *   same handler, served over HTTP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { createSession as createPlaywrightSession } from "../../src/playwright/index.js";
import { createSession as createRequestSession } from "../../src/request/index.js";
import type { Session } from "../../src/session.js";
import { createFixtureApp, type FixtureApp } from "../request/fixture-app.js";

export type Pages = Parameters<typeof createFixtureApp>[0];

/** Options both entry points are meant to accept (see docs/ADAPTER_PARITY.md). */
export interface ContractOptions {
  timeout?: number;
  onStep?: (event: {
    name: string;
    status: "started" | "passed" | "failed";
    error?: unknown;
  }) => void;
}

export interface Harness {
  app: FixtureApp;
  session(options?: ContractOptions): Session<unknown, unknown>;
  close(): Promise<void>;
}

export interface ContractDriver {
  name: "request" | "playwright";
  setUp(): Promise<void>;
  tearDown(): Promise<void>;
  open(pages?: Pages): Promise<Harness>;
}

export const requestDriver: ContractDriver = {
  name: "request",
  async setUp() {},
  async tearDown() {},
  async open(pages) {
    const app = createFixtureApp(pages);
    return {
      app,
      session: (options) =>
        createRequestSession(app.handle, options) as Session<unknown, unknown>,
      close: async () => {},
    };
  },
};

/** Serve a fetch-style handler over HTTP, passing redirects through untouched. */
async function serve(
  handle: (request: Request) => Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }),
    );
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") out[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let browser: Browser | undefined;

export const playwrightDriver: ContractDriver = {
  name: "playwright",
  async setUp() {
    browser = await chromium.launch();
  },
  async tearDown() {
    await browser?.close();
  },
  async open(pages) {
    if (!browser) throw new Error("contract: the browser did not launch");
    const app = createFixtureApp(pages);
    const server = await serve(app.handle);
    const context = await browser.newContext({ baseURL: server.url });
    const page = await context.newPage();
    return {
      app,
      session: (options) =>
        createPlaywrightSession(page, options) as Session<unknown, unknown>,
      close: async () => {
        await context.close();
        await server.close();
      },
    };
  },
};

export const drivers = [requestDriver, playwrightDriver];
