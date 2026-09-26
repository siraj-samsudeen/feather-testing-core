import React, { useEffect, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RTLDriver, toKeyboardSyntax } from "../../src/rtl/driver.js";
import { createSession } from "../../src/rtl/index.js";
import { BrowserOnlyVerbError, StepError } from "../../src/errors.js";

afterEach(() => {
  cleanup();
});

// --- Test Components ---

function FormApp() {
  const [submitted, setSubmitted] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>({});

  return (
    <div>
      {submitted ? (
        <div>
          <p>Form submitted!</p>
          <p>Name: {formData.name}</p>
          <p>Color: {formData.color}</p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setFormData(
              Object.fromEntries(data.entries()) as Record<string, string>,
            );
            setSubmitted(true);
          }}
        >
          <label htmlFor="name">Name</label>
          <input id="name" name="name" />

          <input name="nickname" placeholder="Nickname" />

          <label htmlFor="color">Favorite Color</label>
          <select id="color" name="color">
            <option value="">--Select--</option>
            <option value="r">Red</option>
            <option value="g">Green</option>
            <option value="b">Blue</option>
          </select>

          <label htmlFor="newsletter">Subscribe to newsletter</label>
          <input id="newsletter" name="newsletter" type="checkbox" />

          <label htmlFor="ads">Receive ads</label>
          <input id="ads" name="ads" type="checkbox" defaultChecked />

          <fieldset>
            <legend>Plan</legend>
            <label>
              <input type="radio" name="plan" value="free" /> Free
            </label>
            <label>
              <input type="radio" name="plan" value="pro" /> Pro
            </label>
          </fieldset>

          <button type="submit">Submit</button>
        </form>
      )}
    </div>
  );
}

function LinksApp() {
  const [clicked, setClicked] = useState("");
  return (
    <div>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setClicked("about");
        }}
      >
        About
      </a>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setClicked("contact");
        }}
      >
        Contact
      </a>
      <button onClick={() => setClicked("action")}>Action</button>
      <p>You are here</p>
      {clicked && <p>Clicked: {clicked}</p>}
    </div>
  );
}

function ScopedApp() {
  return (
    <div>
      <div data-testid="sidebar" className="sidebar">
        <p>Sidebar content</p>
        <button>Sidebar Button</button>
      </div>
      <div data-testid="main" className="main">
        <p>Main content</p>
        <button>Main Button</button>
      </div>
    </div>
  );
}

function SubmitByNameApp() {
  const [done, setDone] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDone(true);
      }}
    >
      <label htmlFor="val">Value</label>
      <input id="val" name="val" />
      <button>Submit</button>
      {done && <p>Done!</p>}
    </form>
  );
}

function SubmitByTypeApp() {
  const [done, setDone] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDone(true);
      }}
    >
      <label htmlFor="val">Value</label>
      <input id="val" name="val" />
      <button type="submit">Go</button>
      {done && <p>Done!</p>}
    </form>
  );
}

function SubmitFallbackApp() {
  const [done, setDone] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDone(true);
      }}
    >
      <label htmlFor="val">Value</label>
      <input id="val" name="val" />
      {/* No submit button at all */}
      {done && <p>Done!</p>}
    </form>
  );
}

function SubmitPrecedenceApp() {
  const [result, setResult] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setResult("Saved!");
      }}
    >
      <label htmlFor="val">Value</label>
      <input id="val" name="val" />
      <button type="button" onClick={() => setResult("Wrong button!")}>
        Submit other
      </button>
      <button type="submit">Save</button>
      {result && <p>{result}</p>}
    </form>
  );
}

function UploadApp() {
  const [uploaded, setUploaded] = useState("");
  const [dropped, setDropped] = useState("");
  return (
    <div>
      <form>
        <label htmlFor="avatar">Avatar</label>
        <input
          id="avatar"
          name="avatar"
          type="file"
          onChange={(e) => setUploaded(e.target.files?.[0]?.name ?? "")}
        />
      </form>
      <div
        data-testid="dropzone"
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setDropped(e.dataTransfer.files[0]?.name ?? "");
        }}
      >
        Drop files here
      </div>
      {uploaded && <p>Uploaded: {uploaded}</p>}
      {dropped && <p>Dropped: {dropped}</p>}
    </div>
  );
}

function KeyboardApp() {
  const [keys, setKeys] = useState<string[]>([]);
  return (
    <div>
      <label htmlFor="cmd">Command</label>
      <input
        id="cmd"
        onKeyDown={(e) =>
          setKeys((k) => [...k, `${e.ctrlKey ? "Control+" : ""}${e.key}`])
        }
      />
      <p>Keys: {keys.join(" ")}</p>
    </div>
  );
}

function HoverApp() {
  const [hovered, setHovered] = useState(false);
  return (
    <div>
      <span onMouseEnter={() => setHovered(true)}>Total</span>
      {hovered && <p>Tooltip: 42 items</p>}
    </div>
  );
}

/** Flips from "Working" to "Ready" on its own, the way real async work does. */
function EventuallyApp() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(id);
  }, []);
  return <p>{ready ? "Ready" : "Working"}</p>;
}

function DisappearingApp() {
  const [visible, setVisible] = useState(true);
  return (
    <div>
      <button onClick={() => setVisible(false)}>Hide</button>
      {visible && <p>Temporary text</p>}
    </div>
  );
}

function ExactTextApp({ delayed = false }: { delayed?: boolean }) {
  const [total, setTotal] = useState("Total: 10");
  useEffect(() => {
    if (!delayed) return;
    const id = setTimeout(() => setTotal("Total: 1"), 120);
    return () => clearTimeout(id);
  }, [delayed]);
  return (
    <div>
      <section className="summary">
        <div className="total">{total}</div>
      </section>
      <aside>
        <div className="total">Total: 1</div>
      </aside>
    </div>
  );
}

// --- Tests ---

describe("RTLDriver", () => {
  describe("click()", () => {
    it("finds and clicks an element by text", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.click("You are here");
      // smoke test — didn't throw
    });
  });

  describe("clickLink()", () => {
    it("clicks a link by accessible name", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.clickLink("About");
      expect(screen.getByText("Clicked: about").textContent).toContain("Clicked: about");
    });
  });

  describe("clickButton()", () => {
    it("clicks a button by accessible name", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.clickButton("Action");
      expect(screen.getByText("Clicked: action").textContent).toContain("Clicked: action");
    });
  });

  describe("fillIn()", () => {
    it("fills an input by label", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Name", "Alice");
      expect(screen.getByLabelText("Name")).toHaveProperty("value", "Alice");
    });

    it("falls back to placeholder when label not found", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Nickname", "Ali");
      expect(screen.getByPlaceholderText("Nickname")).toHaveProperty(
        "value",
        "Ali",
      );
    });

    it("clears existing value before typing", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Name", "Alice");
      await driver.fillIn("Name", "Bob");
      expect(screen.getByLabelText("Name")).toHaveProperty("value", "Bob");
    });
  });

  describe("selectOption()", () => {
    it("selects a dropdown option by visible text", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.selectOption("Favorite Color", "Blue");
      expect(screen.getByLabelText("Favorite Color")).toHaveProperty(
        "value",
        "b",
      );
    });

    it("throws when option text not found", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(
        driver.selectOption("Favorite Color", "Purple"),
      ).rejects.toThrow("no <option> with text 'Purple' found");
    });
  });

  describe("check() / uncheck()", () => {
    it("checks an unchecked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.check("Subscribe to newsletter");
      expect(screen.getByLabelText("Subscribe to newsletter")).toHaveProperty(
        "checked",
        true,
      );
    });

    it("does not uncheck an already checked checkbox when check() is called", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      // "Receive ads" is defaultChecked
      await driver.check("Receive ads");
      expect(screen.getByLabelText("Receive ads")).toHaveProperty(
        "checked",
        true,
      );
    });

    it("unchecks a checked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      // "Receive ads" is defaultChecked
      await driver.uncheck("Receive ads");
      expect(screen.getByLabelText("Receive ads")).toHaveProperty(
        "checked",
        false,
      );
    });

    it("does not check an already unchecked checkbox when uncheck() is called", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.uncheck("Subscribe to newsletter");
      expect(screen.getByLabelText("Subscribe to newsletter")).toHaveProperty(
        "checked",
        false,
      );
    });
  });

  describe("choose()", () => {
    it("selects a radio button by label", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.choose("Pro");
      expect(screen.getByRole("radio", { name: "Pro" })).toHaveProperty(
        "checked",
        true,
      );
    });
  });

  describe("submit()", () => {
    it("finds submit button by accessible name containing 'submit'", async () => {
      render(<SubmitByNameApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Done!").textContent).toContain("Done!");
    });

    it("finds submit button by type='submit'", async () => {
      render(<SubmitByTypeApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Done!").textContent).toContain("Done!");
    });

    it("falls back to requestSubmit when no submit button exists", async () => {
      render(<SubmitFallbackApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Done!").textContent).toContain("Done!");
    });

    it("throws when no form was previously interacted with", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(driver.submit()).rejects.toThrow(
        "submit() called but no form was previously interacted with",
      );
    });

    it("prefers type='submit' over accessible name containing 'submit'", async () => {
      render(<SubmitPrecedenceApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Saved!").textContent).toContain("Saved!");
    });
  });

  describe("attachFile()", () => {
    it("attaches a file to a file input by label", async () => {
      render(<UploadApp />);
      const driver = new RTLDriver();
      await driver.attachFile("Avatar", "/some/dir/photo.png");
      expect(screen.getByText("Uploaded: photo.png")).not.toBeNull();
    });

    it("upload() still works as the deprecated alias", async () => {
      render(<UploadApp />);
      const driver = new RTLDriver();
      await driver.upload("Avatar", "/some/dir/photo.png");
      expect(screen.getByText("Uploaded: photo.png")).not.toBeNull();
    });
  });

  describe("pressKey()", () => {
    it("presses a named key on the focused control", async () => {
      render(<KeyboardApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Command", "ls");
      await driver.pressKey("Enter");
      expect(screen.getByText(/Keys: l s Enter/)).not.toBeNull();
    });

    it("presses a modifier combination", async () => {
      render(<KeyboardApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Command", "");
      await driver.pressKey("Control+a");
      expect(screen.getByText(/Control\+a/)).not.toBeNull();
    });

    it("rejects a non-modifier prefix instead of typing it", async () => {
      render(<KeyboardApp />);
      const driver = new RTLDriver();
      await expect(driver.pressKey("Bogus+a")).rejects.toThrow(
        "is not a modifier",
      );
    });
  });

  describe("hover()", () => {
    it("hovers the element with this text", async () => {
      render(<HoverApp />);
      const driver = new RTLDriver();
      await driver.hover("Total");
      expect(screen.getByText("Tooltip: 42 items")).not.toBeNull();
    });
  });

  describe("raw()", () => {
    it("hands the scoped query object to the callback", async () => {
      render(<HoverApp />);
      const driver = new RTLDriver();

      let seen: string | null = null;
      await driver.raw((queries) => {
        seen = queries.getByText("Total").textContent;
      });

      expect(seen).toBe("Total");
    });

    it("scopes to the container inside within()", async () => {
      render(<NestedScopeApp />);
      const driver = new RTLDriver();
      const main = await driver.within(".main");

      await main.raw((queries) => {
        expect(queries.getByText("Main panel")).not.toBeNull();
        expect(queries.queryByText("Sidebar panel")).toBeNull();
      });
    });
  });

  describe("assertDownload()", () => {
    it("throws a browser-only verb error", async () => {
      const driver = new RTLDriver();
      const error = await driver
        .assertDownload("report.csv", async () => {})
        .then(
          () => null,
          (e: unknown) => e as Error,
        );

      expect(error).toBeInstanceOf(BrowserOnlyVerbError);
      expect(error?.message).toContain("browser-only verb");
      expect(error?.message).toContain("assertDownload()");
      expect(error?.message).toContain("Playwright spec");
    });

    it("surfaces through a Session as a named failed step", async () => {
      render(<HoverApp />);
      const session = createSession();

      const error = await session
        .assertText("Total")
        .assertDownload("report.csv", (s) => s.click("Total"))
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );

      expect(error).toBeInstanceOf(StepError);
      expect(error?.message).toContain(
        ">>> [FAILED] assertDownload('report.csv')",
      );
      expect(error?.message).toContain("browser-only verb");
    });
  });

  describe("dropFile()", () => {
    it("dispatches a drop with the file on a selector", async () => {
      render(<UploadApp />);
      const driver = new RTLDriver();
      await driver.dropFile(".dropzone", "/some/dir/report.pdf");
      expect(screen.getByText("Dropped: report.pdf").textContent).toContain("Dropped: report.pdf");
    });

    it("throws when selector matches nothing", async () => {
      render(<UploadApp />);
      const driver = new RTLDriver();
      await expect(
        driver.dropFile(".nonexistent", "file.txt"),
      ).rejects.toThrow("dropFile('.nonexistent'): element not found");
    });
  });

  describe("form-state assertions", () => {
    it("assertValue passes for a filled labeled input", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Name", "Alice");
      await driver.assertValue("Name", "Alice");
    });

    it("assertValue works with placeholder fields", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Nickname", "Ali");
      await driver.assertValue("Nickname", "Ali");
    });

    it("assertValue fails on wrong value", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Name", "Alice");
      await expect(driver.assertValue("Name", "Bob")).rejects.toThrow(
        "expected value 'Bob', but found 'Alice'",
      );
    });

    it("assertChecked passes for a checked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.assertChecked("Receive ads");
    });

    it("assertChecked fails for an unchecked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(
        driver.assertChecked("Subscribe to newsletter"),
      ).rejects.toThrow("expected checkbox to be checked");
    });

    it("refuteChecked passes for an unchecked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.refuteChecked("Subscribe to newsletter");
    });

    it("refuteChecked fails for a checked checkbox", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(driver.refuteChecked("Receive ads")).rejects.toThrow(
        "expected checkbox NOT to be checked",
      );
    });

    it("assertSelected passes for the selected option label", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.selectOption("Favorite Color", "Blue");
      await driver.assertSelected("Favorite Color", "Blue");
    });

    it("assertSelected fails for a non-selected option", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.selectOption("Favorite Color", "Blue");
      await expect(
        driver.assertSelected("Favorite Color", "Red"),
      ).rejects.toThrow("expected selected option 'Red', but found 'Blue'");
    });

    it("assertOptions passes when the select offers exactly these options", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await driver.assertOptions("Favorite Color", [
        "--Select--",
        "Red",
        "Green",
        "Blue",
      ]);
    });

    it("assertOptions fails when the expectation is incomplete", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(
        driver.assertOptions("Favorite Color", ["Red", "Green", "Blue"]),
      ).rejects.toThrow("assertOptions('Favorite Color')");
    });
  });

  describe("step()", () => {
    it("passes the user and container to the callback", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();

      let receivedUser: unknown;
      await driver.step(async ({ user, container }) => {
        receivedUser = user;
        await user.click(await container.findByRole("button", { name: "Action" }));
      });

      expect(typeof (receivedUser as { click?: unknown })?.click).toBe(
        "function",
      );
      expect(screen.getByText("Clicked: action").textContent).toContain("Clicked: action");
    });
  });

  describe("until()", () => {
    it("polls until the condition holds", async () => {
      render(<EventuallyApp />);
      const driver = new RTLDriver();

      await driver.until(
        "the worker reports ready",
        ({ container }) => container.queryByText("Ready") !== null,
        { timeout: 2000 },
      );

      expect(screen.getByText("Ready")).not.toBeNull();
    });

    it("accepts an async predicate", async () => {
      render(<EventuallyApp />);
      const driver = new RTLDriver();

      await driver.until(
        "the worker reports ready",
        async ({ container }) => container.queryByText("Ready"),
        { timeout: 2000 },
      );
    });

    it("names the awaited condition when the budget runs out", async () => {
      render(<EventuallyApp />);
      const driver = new RTLDriver();

      await expect(
        driver.until("the worker reports failure", () => false, {
          timeout: 200,
        }),
      ).rejects.toThrow("until: the worker reports failure");
    });

    it("shows the description in the chain trace through a Session", async () => {
      render(<EventuallyApp />);
      const session = createSession();

      const error = await session
        .assertText("Working")
        .until("the worker reports failure", () => false, { timeout: 200 })
        .assertText("Ready")
        .then(
          () => null,
          (e: unknown) => e as StepError,
        );

      expect(error).toBeInstanceOf(StepError);
      expect(error?.message).toContain("    [ok] assertText('Working')");
      expect(error?.message).toContain(
        ">>> [FAILED] until: the worker reports failure",
      );
      expect(error?.message).toContain("    [skipped] assertText('Ready')");
    });
  });

  describe("assertText()", () => {
    it("passes when text is present", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.assertText("You are here");
    });

    it("throws when text is not present", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await expect(driver.assertText("Not here")).rejects.toThrow();
    });
  });

  describe("assertExactText()", () => {
    it("compares the current scope's whole text, not a numeric prefix", async () => {
      render(<ExactTextApp />);
      const summary = await new RTLDriver().within(".summary");
      const total = await summary.within(".total");

      const error = await total
        .assertExactText("Total: 1", { timeout: 50 })
        .then(
          () => null,
          (cause: unknown) => cause as Error,
        );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("assertExactText('Total: 1')");
      expect(error?.message).toContain("expected normalized text 'Total: 1'");
      expect(error?.message).toContain("but found 'Total: 10'");
      await total.assertExactText("Total: 10");
    });

    it("rejects extra surrounding text and preserves case", async () => {
      render(<div className="total">Prefix Total: 1 suffix</div>);
      const total = await new RTLDriver().within(".total");

      await expect(
        total.assertExactText("Total: 1", { timeout: 50 }),
      ).rejects.toThrow();
      await expect(
        total.assertExactText("prefix total: 1 suffix", { timeout: 50 }),
      ).rejects.toThrow();
    });

    it("normalizes whitespace on both sides", async () => {
      render(
        <div className="total">
          {"\n  Total: "}
          <strong>1</strong>
          {"\t "}
        </div>,
      );
      const total = await new RTLDriver().within(".total");

      await total.assertExactText("  Total:   1  ");
    });

    it("does not use an equal element outside the current scope", async () => {
      render(<ExactTextApp />);
      const summary = await new RTLDriver().within(".summary");
      const total = await summary.within(".total");

      await expect(
        total.assertExactText("Total: 1", { timeout: 50 }),
      ).rejects.toThrow();
    });

    it("retries until the scoped element's text is equal", async () => {
      render(<ExactTextApp delayed />);
      const summary = await new RTLDriver().within(".summary");
      const total = await summary.within(".total");

      await total.assertExactText("Total: 1", { timeout: 1_000 });
    });
  });

  describe("refuteText()", () => {
    it("passes when text is not present", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.refuteText("Nonexistent text");
    });

    it("throws when text is present", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await expect(driver.refuteText("You are here")).rejects.toThrow(
        "Expected NOT to find text 'You are here', but it was present.",
      );
    });

    it("retries until text disappears (waitFor)", async () => {
      render(<DisappearingApp />);
      const driver = new RTLDriver();

      // Text is present initially
      expect(screen.queryByText("Temporary text")).not.toBeNull();

      // Click the hide button
      await driver.clickButton("Hide");

      // refuteText should succeed because waitFor retries
      await driver.refuteText("Temporary text");
    });
  });

  describe("within()", () => {
    it("scopes queries to a container element", async () => {
      render(<ScopedApp />);
      const driver = new RTLDriver();

      const scoped = await driver.within(".sidebar");
      await scoped.assertText("Sidebar content");
      await scoped.clickButton("Sidebar Button");
    });

    it("scoped driver cannot see elements outside the container", async () => {
      render(<ScopedApp />);
      const driver = new RTLDriver();

      const scoped = await driver.within(".sidebar");
      await expect(scoped.assertText("Main content")).rejects.toThrow();
    });

    it("throws when selector matches nothing", async () => {
      render(<ScopedApp />);
      const driver = new RTLDriver();

      await expect(driver.within(".nonexistent")).rejects.toThrow(
        "within('.nonexistent'): element not found",
      );
    });
  });

  describe("debug()", () => {
    it("calls screen.debug without throwing", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await driver.debug();
      spy.mockRestore();
    });
  });

  describe("unsupported methods throw", () => {
    it("visit() throws", async () => {
      const driver = new RTLDriver();
      await expect(driver.visit("/")).rejects.toThrow(
        "visit() is not available in the RTL adapter",
      );
    });

    it("assertPath() throws", async () => {
      const driver = new RTLDriver();
      await expect(driver.assertPath("/")).rejects.toThrow(
        "assertPath() is not available in the RTL adapter",
      );
    });

    it("refutePath() throws", async () => {
      const driver = new RTLDriver();
      await expect(driver.refutePath("/")).rejects.toThrow(
        "refutePath() is not available in the RTL adapter",
      );
    });

    it("assertHas() throws", async () => {
      const driver = new RTLDriver();
      await expect(driver.assertHas("div")).rejects.toThrow(
        "assertHas() with CSS selectors is not recommended in RTL",
      );
    });

    it("refuteHas() throws", async () => {
      const driver = new RTLDriver();
      await expect(driver.refuteHas("div")).rejects.toThrow(
        "refuteHas() with CSS selectors is not recommended in RTL",
      );
    });
  });
});

// Mirrors tests/playwright's /collision page: a navigation chip whose
// accessible name merely CONTAINS the name of the control the spec wants.
function CollisionApp() {
  const [msg, setMsg] = useState("");
  return (
    <div>
      <nav className="sidebar">
        <button>Checklist Run — checklist</button>
        <a href="/about">About the checklist</a>
      </nav>
      <main>
        <form>
          <label htmlFor="company">Name of company</label>
          <input id="company" name="company" />

          <label htmlFor="who">Name</label>
          <input id="who" name="who" />
        </form>
        <button onClick={() => setMsg("Checked!")}>Check</button>
        <a href="/about">About</a>
        <p>{msg}</p>
      </main>
    </div>
  );
}

/**
 * The RTL adapter addresses controls exactly already — RTL's string matchers
 * are whole-string by default. These pin that guarantee so the two adapters
 * keep answering the same question: the Playwright driver had to be taught
 * `exact: true` after `clickButton('Check')` matched a "Checklist Run —
 * checklist" chip too and tripped strict mode.
 */
describe("RTLDriver — exact addressing", () => {
  it("clickButton picks the exactly-named button over a longer-named one", async () => {
    render(<CollisionApp />);
    const driver = new RTLDriver();
    await driver.clickButton("Check");
    await driver.assertText("Checked!");
  });

  it("clickButton fails when no button matches exactly", async () => {
    render(<CollisionApp />);
    const driver = new RTLDriver();
    // "Chec" is a substring of both buttons and the exact name of neither.
    await expect(driver.clickButton("Chec")).rejects.toThrow();
  });

  it("clickLink picks the exactly-named link", async () => {
    render(<CollisionApp />);
    const driver = new RTLDriver();
    await driver.clickLink("About");
  });

  it("fillIn picks the exactly-labelled field", async () => {
    render(<CollisionApp />);
    const driver = new RTLDriver();
    await driver.fillIn("Name", "Alice");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Alice",
    );
    expect(
      (screen.getByLabelText("Name of company") as HTMLInputElement).value,
    ).toBe("");
  });
});

// Two panels with identical inner markup: a driver scoped to `.main` must
// resolve `.panel` inside its own scope, not from the top of the document.
function NestedScopeApp() {
  return (
    <div>
      <div className="sidebar">
        <div className="panel">
          <p>Sidebar panel</p>
        </div>
      </div>
      <div className="main">
        <div className="panel">
          <p>Main panel</p>
        </div>
      </div>
    </div>
  );
}

describe("RTLDriver — scoping resolves against the current scope", () => {
  it("within() nests", async () => {
    render(<NestedScopeApp />);
    const driver = new RTLDriver();

    const main = await driver.within(".main");
    const panel = await main.within(".panel");

    await panel.assertText("Main panel");
    await expect(panel.assertText("Sidebar panel")).rejects.toThrow();
  });

  it("a driver constructed with a container scopes selector lookups too", async () => {
    render(<NestedScopeApp />);
    const mainEl = document.querySelector(".main") as HTMLElement;
    const driver = new RTLDriver(undefined, mainEl);

    const panel = await driver.within(".panel");
    await panel.assertText("Main panel");
  });
});

// Labels with no htmlFor and no nesting — the control is a sibling inside a
// wrapper. RTL's own findByLabelText cannot see these, which is exactly the
// case a host adapter specializes findField() for.
function WrapperLabelApp() {
  return (
    <form>
      <div>
        <label>Subject</label>
        <input name="subject" defaultValue="" />
      </div>
    </form>
  );
}

class WrapperLabelDriver extends RTLDriver {
  protected override async findField(label: string): Promise<HTMLElement> {
    for (const l of Array.from(this.rootElement().querySelectorAll("label"))) {
      if ((l.textContent ?? "").trim() !== label) continue;
      const sibling = l.parentElement?.querySelector("input, textarea, select");
      if (sibling) return sibling as HTMLElement;
    }
    throw new Error(`no field labelled '${label}'`);
  }

  protected override scoped(element: HTMLElement) {
    return new WrapperLabelDriver(this.user, element, this.timeout);
  }
}

describe("RTLDriver — findField() is the seam for a host adapter's markup", () => {
  it("overriding findField retargets every labelled verb", async () => {
    render(<WrapperLabelApp />);
    const stock = new RTLDriver();
    // The stock lookup genuinely cannot find this control...
    await expect(stock.fillIn("Subject", "x")).rejects.toThrow();

    // ...and one overridden method is enough to fix fillIn AND the
    // assertions that never mention findField themselves.
    const driver = new WrapperLabelDriver();
    await driver.fillIn("Subject", "Sales mismatch");
    await driver.assertValue("Subject", "Sales mismatch");
  });

  it("within() keeps the subclass's lookup", async () => {
    render(<WrapperLabelApp />);
    const driver = new WrapperLabelDriver();
    const scoped = await driver.within("form");
    await scoped.fillIn("Subject", "scoped");
    await scoped.assertValue("Subject", "scoped");
  });
});

describe("toKeyboardSyntax()", () => {
  it("wraps named keys and passes printable characters through", () => {
    expect(toKeyboardSyntax("Enter")).toBe("{Enter}");
    expect(toKeyboardSyntax("Escape")).toBe("{Escape}");
    expect(toKeyboardSyntax("a")).toBe("a");
    expect(toKeyboardSyntax("Space")).toBe(" ");
  });

  it("escapes user-event's own descriptor characters", () => {
    expect(toKeyboardSyntax("{")).toBe("{{");
    expect(toKeyboardSyntax("[")).toBe("[[");
  });

  it("holds modifiers around the key and releases them in reverse", () => {
    expect(toKeyboardSyntax("Control+A")).toBe("{Control>}A{/Control}");
    expect(toKeyboardSyntax("Ctrl+Shift+p")).toBe(
      "{Control>}{Shift>}p{/Shift}{/Control}",
    );
    expect(toKeyboardSyntax("Meta+Enter")).toBe("{Meta>}{Enter}{/Meta}");
  });

  it("rejects a prefix that is not a modifier", () => {
    expect(() => toKeyboardSyntax("Bogus+a")).toThrow("is not a modifier");
  });
});
