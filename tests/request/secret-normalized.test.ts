// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSession } from "../../src/request/index.js";
import { StepError } from "../../src/errors.js";
import { createFixtureApp } from "./fixture-app.js";

describe("a secret fillIn that fails", () => {
  it("withholds the driver's message: a normalized copy of the value (a trimmed email) cannot leak", async () => {
    const app = createFixtureApp({
      "/backup": `<form><label for="e">Backup email</label><input id="e" type="email"></form>`,
    });
    const error = await createSession(app.handle)
      .visit("/backup")
      .fillIn("Backup email", "  hidden.person@example.com  ", { sensitive: true })
      .run()
      .then(
        () => null,
        (e: unknown) => e as StepError,
      );
    expect(error).toBeInstanceOf(StepError);
    expect(error!.message).not.toContain("hidden.person@example.com");
    expect(String((error!.cause as Error).message)).not.toContain("hidden.person");
    expect(error!.message).toContain(
      "fillIn('Backup email', '••••••') failed on the field labelled 'Backup email' (a secret field)",
    );
    expect(error!.message).toContain("debug()");
  });
});
