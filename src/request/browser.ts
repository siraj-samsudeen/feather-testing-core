import { Window } from "happy-dom";
import { CookieJar } from "./cookies.js";
import { describeControl } from "./dom.js";
import {
  buildSubmission,
  firstMissingRequired,
  type AttachedFiles,
} from "./form.js";

/** Anything that turns a Request into a Response: Elysia's `app.handle`,
 * Hono's `app.fetch`, or `fetch` itself pointed at a running server. */
export type RequestHandler = (request: Request) => Response | Promise<Response>;

/** A response the browser saved instead of showing. */
export interface Download {
  url: URL;
  /** The name a browser would save it under. */
  suggestedFilename: string;
  response: Response;
}

/** The page the session is on: what the last navigation produced. */
export interface CurrentPage {
  url: URL;
  /** The request that produced this page (after following redirects). */
  request: Request;
  response: Response;
  /** The response body as received. */
  body: string;
  document: Document;
}

/**
 * The state one browser tab would hold — current page, cookies — shared by a
 * driver and every within()-scoped driver made from it, so a navigation
 * inside a scope is seen by the whole session.
 */
export class RequestBrowser {
  private window: Window;
  private page: CurrentPage | null = null;
  private cookies = new CookieJar();
  /** Files attached to file inputs of the current page. */
  readonly files: AttachedFiles = new WeakMap();
  /** Every download so far, oldest first. */
  readonly downloads: Download[] = [];

  constructor(
    private handler: RequestHandler,
    readonly baseUrl: URL,
  ) {
    this.window = new Window({
      url: baseUrl.href,
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
        disableIframePageLoading: true,
        disableComputedStyleRendering: true,
        navigation: {
          disableMainFrameNavigation: true,
          disableChildFrameNavigation: true,
          disableChildPageNavigation: true,
          disableFallbackToSetURL: true,
        },
      },
    });
  }

  get current(): CurrentPage {
    if (!this.page) {
      throw new Error("No page loaded yet: start the chain with visit(path).");
    }
    return this.page;
  }

  /** "GET http://localhost/ (200)": which page a failure happened on. */
  describe(): string {
    if (!this.page) return "no page";
    const { request, response, url } = this.page;
    return `${request.method} ${url.href} (${response.status})`;
  }

  /**
   * Navigate the tab: send the request, follow redirects the way a
   * browser's fetch does, and show the final response. `verb` names the step
   * in errors.
   */
  async navigate(
    verb: string,
    url: URL,
    init: {
      method?: string;
      body?: BodyInit | null;
      headers?: HeadersInit;
      /** Save the final response as a download whatever it is, with this
       * name if the response does not name it (`<a download>`). */
      download?: string;
    } = {},
  ): Promise<void> {
    let method = init.method ?? "GET";
    let body = init.body ?? null;
    let extraHeaders = new Headers(init.headers);
    let target = url;
    for (let hops = 0; ; hops++) {
      if (hops > MAX_REDIRECTS) {
        throw new Error(
          `${verb}: more than ${MAX_REDIRECTS} redirects, last to ${target.href}`,
        );
      }
      const request = this.buildRequest(target, method, body, extraHeaders);
      const response = await this.handler(request.clone());
      this.cookies.store(target, response.headers);

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        // fetch's rules: 303 always becomes a GET; 301/302 turn a POST into a
        // GET; 307/308 resend the same method and body.
        const becomesGet =
          response.status === 303
            ? method !== "HEAD"
            : (response.status === 301 || response.status === 302) &&
              method === "POST";
        if (becomesGet) {
          method = "GET";
          body = null;
          extraHeaders = withoutBodyHeaders(extraHeaders);
        }
        target = new URL(location, target);
        continue;
      }

      const disposition = response.headers.get("content-disposition") ?? "";
      if (init.download !== undefined || /^\s*attachment/i.test(disposition)) {
        // A browser saves an attachment and stays on the page it was on.
        this.downloads.push({
          url: target,
          suggestedFilename:
            dispositionFilename(disposition) ||
            init.download ||
            decodeURIComponent(target.pathname.split("/").pop() ?? "") ||
            "download",
          response,
        });
        return;
      }
      await this.show(target, request, response);
      return;
    }
  }

  /** Follow a link. Only the fragment changing is a same-document
   * navigation: no request, just a new URL. */
  async followLink(verb: string, url: URL, download?: string): Promise<void> {
    const current = this.current.url;
    if (
      download === undefined &&
      url.hash !== "" &&
      withoutHash(url) === withoutHash(current)
    ) {
      this.current.url = url;
      return;
    }
    await this.navigate(verb, url, { download });
  }

  /**
   * Send a request with the tab's cookies without navigating, the way a
   * page's own fetch() would. Relative URLs resolve against the current page.
   */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input, this.page?.url ?? this.baseUrl);
    const headers = new Headers(init.headers);
    const cookie = this.cookies.header(url);
    if (cookie !== null && !headers.has("cookie"))
      headers.set("cookie", cookie);
    const response = await this.handler(
      new Request(url, { ...init, headers, redirect: "manual" }),
    );
    this.cookies.store(url, response.headers);
    return response;
  }

  /** Submit `form` as if `submitter` (or implicit submission, when null)
   * had sent it. */
  async submit(
    verb: string,
    form: HTMLFormElement,
    submitter: Element | null,
  ): Promise<void> {
    const missing = firstMissingRequired(form, submitter, this.files);
    if (missing) {
      throw new Error(
        `${verb}: a browser would not submit this form: '${describeControl(missing)}' is required but empty.`,
      );
    }
    const { method, url, body, headers } = buildSubmission(
      verb,
      form,
      submitter,
      this.current.url,
      this.files,
    );
    await this.navigate(verb, url, { method, body, headers });
  }

  /** Send the request that produced the current page once more. */
  async reload(): Promise<void> {
    const { request, url } = this.current;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.clone().arrayBuffer();
    await this.navigate("reload()", url, {
      method: request.method,
      body,
      headers: bodyHeaders(request.headers),
    });
  }

  private buildRequest(
    url: URL,
    method: string,
    body: BodyInit | null,
    extraHeaders: Headers,
  ): Request {
    const headers = new Headers(extraHeaders);
    headers.set("accept", "text/html,application/xhtml+xml,*/*;q=0.8");
    if (method !== "GET" && method !== "HEAD") {
      // Browsers send Origin with every unsafe request; CSRF checks read it.
      headers.set("origin", (this.page?.url ?? url).origin);
    }
    const cookie = this.cookies.header(url);
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request(url, { method, body, headers, redirect: "manual" });
  }

  private async show(
    url: URL,
    request: Request,
    response: Response,
  ): Promise<void> {
    const body = await response.clone().text();
    const type = (
      response.headers.get("content-type") ?? "text/html"
    ).toLowerCase();
    const parser = new this.window.DOMParser();
    let document: Document;
    if (type.includes("html")) {
      document = parser.parseFromString(
        body,
        "text/html",
      ) as unknown as Document;
    } else {
      // What a browser shows for text, JSON and the like: the body, as is.
      document = parser.parseFromString(
        "<pre></pre>",
        "text/html",
      ) as unknown as Document;
      document.querySelector("pre")!.textContent = body;
    }
    this.page = { url, request, response, body, document };
  }
}

/** The filename a Content-Disposition header names, preferring the RFC 6266
 * `filename*` form; "" when it names none. */
function dispositionFilename(header: string): string {
  const extended = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = header.match(
    /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i,
  );
  if (!plain) return "";
  return (plain[1] ?? plain[2]).replace(/\\(.)/g, "$1");
}

function withoutHash(url: URL): string {
  return url.href.slice(0, url.href.length - url.hash.length);
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-type"];

function bodyHeaders(headers: Headers): Headers {
  const kept = new Headers();
  for (const name of BODY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}

function withoutBodyHeaders(headers: Headers): Headers {
  const kept = new Headers(headers);
  for (const name of BODY_HEADERS) kept.delete(name);
  return kept;
}
