/**
 * A cookie jar with the parts of RFC 6265 a test session meets: host-only
 * and Domain cookies, Path scoping, Max-Age/Expires (including deletion),
 * and Secure. It does not know the public-suffix list, so `Domain=com` is
 * accepted — a test talks to its own app, not to strangers.
 */

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires: number | null;
}

/** The default-path of RFC 6265 §5.1.4: the request path's directory. */
function defaultPath(url: URL): string {
  const { pathname } = url;
  if (!pathname.startsWith("/") || pathname.lastIndexOf("/") === 0) return "/";
  return pathname.slice(0, pathname.lastIndexOf("/"));
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Secure cookies go over https, and to localhost, as browsers allow. */
function isSecureContext(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1"
  );
}

export class CookieJar {
  private cookies: Cookie[] = [];

  /** Store every Set-Cookie header of a response to a request for `url`. */
  store(url: URL, headers: Headers): void {
    for (const header of headers.getSetCookie()) {
      this.storeOne(url, header);
    }
  }

  private storeOne(url: URL, header: string): void {
    const [pair, ...attributes] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === "") return;

    const host = url.hostname.toLowerCase();
    const cookie: Cookie = {
      name,
      value,
      domain: host,
      hostOnly: true,
      path: defaultPath(url),
      secure: false,
      expires: null,
    };
    let maxAgeSeen = false;
    for (const attribute of attributes) {
      const sep = attribute.indexOf("=");
      const key = (sep < 0 ? attribute : attribute.slice(0, sep))
        .trim()
        .toLowerCase();
      const val = sep < 0 ? "" : attribute.slice(sep + 1).trim();
      if (key === "domain" && val !== "") {
        const domain = val.replace(/^\./, "").toLowerCase();
        // A server may only set cookies for itself or a parent domain.
        if (!domainMatches(host, domain)) return;
        cookie.domain = domain;
        cookie.hostOnly = false;
      } else if (key === "path" && val.startsWith("/")) {
        cookie.path = val;
      } else if (key === "secure") {
        cookie.secure = true;
      } else if (key === "max-age" && /^-?\d+$/.test(val)) {
        maxAgeSeen = true;
        cookie.expires = Date.now() + Number(val) * 1000;
      } else if (key === "expires" && !maxAgeSeen) {
        const time = Date.parse(val);
        if (!Number.isNaN(time)) cookie.expires = time;
      }
    }

    this.cookies = this.cookies.filter(
      (c) =>
        !(
          c.name === cookie.name &&
          c.domain === cookie.domain &&
          c.path === cookie.path
        ),
    );
    if (cookie.expires === null || cookie.expires > Date.now()) {
      this.cookies.push(cookie);
    }
  }

  /**
   * Put a cookie in the jar directly, as a session that starts signed in
   * would have it. Without a domain it is host-only for `base`'s host.
   */
  seed(
    cookie: {
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      secure?: boolean;
    },
    base: URL,
  ): void {
    const domain = (cookie.domain ?? base.hostname).replace(/^\./, "").toLowerCase();
    this.cookies = this.cookies.filter(
      (c) =>
        !(c.name === cookie.name && c.domain === domain && c.path === (cookie.path ?? "/")),
    );
    this.cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain,
      hostOnly: cookie.domain === undefined,
      path: cookie.path ?? "/",
      secure: cookie.secure === true,
      expires: cookie.expires === undefined ? null : cookie.expires * 1000,
    });
  }

  /** The Cookie header a browser would send with a request to `url`, or null. */
  header(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    const now = Date.now();
    this.cookies = this.cookies.filter(
      (c) => c.expires === null || c.expires > now,
    );
    const matching = this.cookies
      .filter(
        (c) =>
          (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) &&
          pathMatches(url.pathname, c.path) &&
          (!c.secure || isSecureContext(url)),
      )
      // Longer paths first (RFC 6265 §5.4); stable sort keeps creation order otherwise.
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.length === 0) return null;
    return matching.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}
