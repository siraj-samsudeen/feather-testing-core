import { describe, it, expect } from "vitest";
import { SecretRegistry, maskPasswordInputs } from "../../src/secrets.js";

describe("maskPasswordInputs", () => {
  it("masks every password input's value in an HTML dump, seen or not", () => {
    const dump =
      '<input type="password" value="never-seen-1"><input value="keep-me" type="text">' +
      "<input value='never-seen-2' id=\"x\" type='password'>";
    const masked = maskPasswordInputs(dump);
    expect(masked).not.toContain("never-seen-1");
    expect(masked).not.toContain("never-seen-2");
    expect(masked).toContain("keep-me");
  });

  it("masks a colourised dump (Testing Library's prettyDOM)", () => {
    const dump =
      "\u001b[36m<input\u001b[39m \u001b[33mtype\u001b[39m=\u001b[32m\"password\"\u001b[39m " +
      "\u001b[33mvalue\u001b[39m=\u001b[32m\"never-seen\"\u001b[39m \u001b[36m/>\u001b[39m";
    expect(maskPasswordInputs(dump)).not.toContain("never-seen");
  });
});

describe("SecretRegistry", () => {
  it("scrubs registered values from an error, its stack and its cause chain", () => {
    const secrets = new SecretRegistry();
    secrets.addValue("hunter2-secret");
    const cause = new Error("server said hunter2-secret");
    const error = new Error("outer hunter2-secret", { cause });
    secrets.scrubError(error);
    expect(error.message).toBe("outer ••••••");
    expect(String(error.stack)).not.toContain("hunter2-secret");
    expect(cause.message).toBe("server said ••••••");
  });

  it("hides the longest secret whole when one contains another", () => {
    const secrets = new SecretRegistry();
    secrets.addValue("abc");
    secrets.addValue("abcdef");
    expect(secrets.scrub("x abcdef y abc")).toBe("x •••••• y ••••••");
  });

  it("does not scrub values shorter than 3 characters", () => {
    const secrets = new SecretRegistry();
    secrets.addValue("a");
    expect(secrets.scrub("a cat")).toBe("a cat");
  });
});
