import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RTLDriver } from "../../src/rtl/driver.js";

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

function DisappearingApp() {
  const [visible, setVisible] = useState(true);
  return (
    <div>
      <button onClick={() => setVisible(false)}>Hide</button>
      {visible && <p>Temporary text</p>}
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
      expect(screen.getByText("Clicked: about")).toBeTruthy();
    });
  });

  describe("clickButton()", () => {
    it("clicks a button by accessible name", async () => {
      render(<LinksApp />);
      const driver = new RTLDriver();
      await driver.clickButton("Action");
      expect(screen.getByText("Clicked: action")).toBeTruthy();
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
      expect(screen.getByText("Done!")).toBeTruthy();
    });

    it("finds submit button by type='submit'", async () => {
      render(<SubmitByTypeApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Done!")).toBeTruthy();
    });

    it("falls back to requestSubmit when no submit button exists", async () => {
      render(<SubmitFallbackApp />);
      const driver = new RTLDriver();
      await driver.fillIn("Value", "test");
      await driver.submit();
      expect(screen.getByText("Done!")).toBeTruthy();
    });

    it("throws when no form was previously interacted with", async () => {
      render(<FormApp />);
      const driver = new RTLDriver();
      await expect(driver.submit()).rejects.toThrow(
        "submit() called but no form was previously interacted with",
      );
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
