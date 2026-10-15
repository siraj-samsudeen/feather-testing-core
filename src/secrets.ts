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
