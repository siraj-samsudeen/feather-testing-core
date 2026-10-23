/**
 * Keeping secrets out of failure reports.
 *
 * Every step has a name that ends up in the chain trace, in Playwright's
 * test.step titles, and so in CI logs and HTML reports. A value typed into a
 * password field must never appear there, so such values are shown as
 * HIDDEN_VALUE instead. It has a fixed length so it does not reveal the real
 * value's length either.
 */
export const HIDDEN_VALUE = "••••••";

/**
 * Labels that name a secret. Matched anywhere in the label, ignoring case,
 * except "pin" and "otp", which must be whole words so that "Pincode" and
 * "Footprint" do not count.
 */
const SECRET_LABEL =
  /password|passcode|secret|token|api[\s_-]?key|\bpin\b|\botp\b/i;

export function labelLooksSecret(label: string): boolean {
  return SECRET_LABEL.test(label);
}

/**
 * Replace every copy of `value` in an error's message and stack with
 * HIDDEN_VALUE. Drivers can echo the value they were filling — Playwright's
 * call log prints `fill("<value>")` — and reporters print both the chain's
 * error and its cause.
 */
export function hideValueInError(error: unknown, value: string): unknown {
  if (value === "") {
    return error;
  }
  if (error instanceof Error) {
    error.message = error.message.replaceAll(value, HIDDEN_VALUE);
    if (error.stack) {
      error.stack = error.stack.replaceAll(value, HIDDEN_VALUE);
    }
    return error;
  }
  if (typeof error === "string") {
    return error.replaceAll(value, HIDDEN_VALUE);
  }
  return error;
}

/** Values shorter than this are not scrubbed: replacing "a" everywhere would wreck every message. */
const MIN_SCRUBBED_LENGTH = 3;

// eslint-disable-next-line no-control-regex -- matches ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Mask the value of every `<input type="password">` in an HTML dump (Testing
 * Library's prettyDOM, a page's outerHTML), whether or not the session ever
 * saw that value. Colour codes inside such a tag are dropped.
 */
export function maskPasswordInputs(text: string): string {
  return text.replace(/<input\b[^>]*>/gi, (tag) => {
    const plain = tag.replace(ANSI, "");
    if (!/\btype\s*=\s*["']?password["']?/i.test(plain)) return tag;
    return plain.replace(
      /\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i,
      `value="${HIDDEN_VALUE}"`,
    );
  });
}

/**
 * Every secret value a session (and the sessions within() and
 * assertDownload() make from it) has hidden, and the labels of fields it
 * knows to be secret. One scrub() removes them from anything that leaves the
 * session: step names, onStep events, test.step titles, errors (message,
 * stack, cause chain), StepError chains and debug() output.
 *
 * It cannot scrub what it never saw: a secret the session never hid (typed
 * outside the DSL, or under an ordinary label into an ordinary field), or a
 * transformed form of one (encoded, hashed, cut).
 */
export class SecretRegistry {
  private values = new Set<string>();
  private labels = new Set<string>();

  addValue(value: string): void {
    if (value.length >= MIN_SCRUBBED_LENGTH) this.values.add(value);
  }

  addLabel(label: string): void {
    this.labels.add(label);
  }

  hasLabel(label: string): boolean {
    return this.labels.has(label);
  }

  /** Every registered value, and every password input's value, hidden. */
  scrub(text: string): string {
    let out = maskPasswordInputs(text);
    // Longest first, so a secret that contains another is hidden whole.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.replaceAll(value, HIDDEN_VALUE);
    }
    return out;
  }

  /** Scrub an error in place — message, stack, string fields, its cause chain. */
  scrubError<T>(error: T, seen = new WeakSet<object>()): T {
    if (typeof error === "string") return this.scrub(error) as T;
    if (error === null || typeof error !== "object" || seen.has(error)) {
      return error;
    }
    seen.add(error);
    const record = error as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(error)) {
      const value = record[key];
      try {
        if (typeof value === "string") {
          record[key] = this.scrub(value);
        } else if (Array.isArray(value)) {
          record[key] = value.map((item) =>
            typeof item === "string" ? this.scrub(item) : this.scrubError(item, seen),
          );
        } else if (key === "cause" && value !== null && typeof value === "object") {
          this.scrubError(value, seen);
        }
      } catch {
        // A read-only property: leave it.
      }
    }
    return error;
  }

  /** Run `fn` with console output scrubbed (debug() prints through it). */
  async scrubConsoleDuring(fn: () => Promise<void>): Promise<void> {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    methods.forEach((m, i) => {
      const original = originals[i]!;
      console[m] = (...args: unknown[]) =>
        original.apply(
          console,
          args.map((arg) => (typeof arg === "string" ? this.scrub(arg) : arg)),
        );
    });
    try {
      await fn();
    } finally {
      methods.forEach((m, i) => {
        console[m] = originals[i]!;
      });
    }
  }
}
