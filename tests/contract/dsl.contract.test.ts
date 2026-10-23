// @vitest-environment node
/**
 * The DSL contract: one spec, run against every driver. Each test is a row
 * marked "same" in docs/ADAPTER_PARITY.md (its number is in the title); a
 * row that cannot mean the same thing without a browser is documented there,
 * not tested here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StepError } from "../../src/errors.js";
import { drivers, type Harness, type Pages } from "./drivers.js";

const AVATAR = new URL("../request/files/avatar.png", import.meta.url).pathname;
const NOTES = new URL("../request/files/notes.txt", import.meta.url).pathname;
const FAKE_SECRET = "fake-secret-value-123";
const HIDDEN = "••••••";
const TEST_TIMEOUT = 20_000;

/** A failure for assertions that are meant to fail, in well under a second. */
const FAST = { timeout: 300 };

const formState = `
  <form>
    <label for="name">Name</label><input id="name" name="name" value="Ada">
    <label for="nick">Nickname</label><input id="nick" name="nick">
    <label for="news">Newsletter</label><input type="checkbox" id="news" name="news">
    <label for="terms">Terms</label><input type="checkbox" id="terms" name="terms" checked>
    <label for="free">Free</label><input type="radio" id="free" name="plan" value="free" checked>
    <label for="pro">Pro</label><input type="radio" id="pro" name="plan" value="pro">
    <label for="color">Color</label>
    <select id="color" name="color"><option>Red</option><option>Green</option></select>
  </form>`;

const pages: Pages = {
  "/state": formState,
  "/ambiguous": `<label for="a">Code</label><input id="a"><label for="b">Code</label><input id="b">`,
  "/links": `<a id="about" href="/about" class="nav">About us</a><a href="/report.csv">Report</a>`,
  "/uploads": `
    <form method="post" action="/echo" enctype="multipart/form-data">
      <label for="avatar">Avatar</label><input type="file" id="avatar" name="avatar">
      <label for="notes">Notes</label><input type="file" id="notes" name="notes">
      <button>Upload</button>
    </form>`,
  "/redirects": `
    <form method="post" action="/redirect/303"><input name="q" value="a"><button>See other</button></form>
    <form method="post" action="/redirect/307"><input name="q" value="b"><button>Temporary</button></form>`,
  "/search": `<form action="/echo"><label for="q">Query</label><input id="q" name="q"><button>Search</button></form>`,
  "/codes": `
    <form method="post" action="/echo">
      <label for="code">Login code</label><input id="code" name="code" type="password">
      <button>Send</button>
    </form>`,
  "/list": `<ul><li class="item">One</li><li class="item">Two</li></ul>`,
  "/dialog": `<p>Behind the dialog</p>
    <dialog open><form method="dialog"><p>Are you sure?</p><button>Close</button></form></dialog>`,
};

for (const driver of drivers) {
  describe(`DSL contract: ${driver.name} driver`, () => {
    beforeAll(() => driver.setUp(), 30_000);
    afterAll(() => driver.tearDown());

    /** Run `fn` with a fresh app, browser context and session. */
    async function withApp(fn: (h: Harness) => Promise<void>): Promise<void> {
      const harness = await driver.open(pages);
      try {
        await fn(harness);
      } finally {
        await harness.close();
      }
    }

    /** The StepError a chain fails with. */
    async function failure(chain: { run(): Promise<void> }): Promise<StepError> {
      const error = await chain.run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StepError);
      return error as StepError;
    }

    it("#15 #36 visit, then case-insensitive text assertions", async () => {
      await withApp(async (h) => {
        await h.session().visit("/about").assertText("ABOUT").refuteText("Dashboard");
      });
    }, TEST_TIMEOUT);

    it("#37 assertExactText on a scope", async () => {
      await withApp(async (h) => {
        await h.session().visit("/about").within("h1", (s) => s.assertExactText("About"));
      });
    }, TEST_TIMEOUT);

    it("#17 clickLink follows the link; the next step sees the new page", async () => {
      await withApp(async (h) => {
        await h.session().visit("/about").clickLink("Back to todos").assertPath("/").assertText("todos");
      });
    }, TEST_TIMEOUT);

    it("#17 clickButton posts the form, follows the 303, and shows the new page", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/")
          .fillIn("What needs to be done?", "Read the guide")
          .clickButton("Add")
          .assertPath("/")
          .assertHas("li.todo", { count: 1 })
          .assertText("Read the guide")
          .assertText("1 items left");
      });
    }, TEST_TIMEOUT);

    it("#18 submit() submits the form last filled in", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/")
          .fillIn("What needs to be done?", "Via submit")
          .submit()
          .assertHas("li.todo", { text: "Via submit", count: 1 });
      });
    }, TEST_TIMEOUT);

    it("#19 pressKey('Enter') submits the form", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/")
          .fillIn("What needs to be done?", "Via Enter")
          .pressKey("Enter")
          .assertHas("li.todo", { text: "Via Enter", count: 1 });
      });
    }, TEST_TIMEOUT);

    it("#21 a 303 after a POST is followed with GET", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/redirects")
          .clickButton("See other")
          .assertPath("/echo")
          .within("#method", (s) => s.assertExactText("GET"));
      });
    }, TEST_TIMEOUT);

    it("#21 a 307 after a POST is followed with POST and its body", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/redirects")
          .clickButton("Temporary")
          .assertPath("/echo")
          .within("#method", (s) => s.assertExactText("POST"))
          .assertText("body q=b");
      });
    }, TEST_TIMEOUT);

    it("#28 cookies are kept across redirects and requests, and deleted", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/login")
          .fillIn("Email", "ada@example.com")
          .fillIn("Password", "pw")
          .clickButton("Sign in")
          .assertPath("/dashboard")
          .assertText("Signed in as ada@example.com")
          .assertText("Welcome")
          .clickLink("Sign out")
          .assertPath("/login")
          .visit("/dashboard")
          .assertPath("/login");
      });
    }, TEST_TIMEOUT);

    it("#16 reload fetches the same URL again and keeps cookies", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/counter")
          .assertText("Count: 1")
          .reload()
          .assertText("Count: 2")
          .visit("/login")
          .fillIn("Email", "ada@example.com")
          .clickButton("Sign in")
          .reload()
          .assertText("Signed in as ada@example.com");
      });
    }, TEST_TIMEOUT);

    it("#29 a form post carries an Origin header", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/redirects")
          .clickButton("Temporary")
          .assertHas("#origin", { text: "http" });
      });
    }, TEST_TIMEOUT);

    it("#30 attachFile sends each file's bytes, name and type", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/uploads")
          .attachFile("Avatar", AVATAR)
          .upload("Notes", NOTES)
          .clickButton("Upload")
          .assertText("body avatar=file:avatar.png:image/png:12:hello avatar")
          .assertText("body notes=file:notes.txt:text/plain:");
      });
    }, TEST_TIMEOUT);

    it("#32 #23 assertDownload sees the file; the session stays on its page", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/links")
          .assertDownload("report.csv", (s) => s.clickLink("Report"))
          .assertPath("/links");
      });
    }, TEST_TIMEOUT);

    it("#24 a method=\"dialog\" form closes its dialog and sends nothing", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/dialog")
          .clickButton("Close")
          .assertPath("/dialog")
          .assertHas("dialog", { count: 1 })
          .refuteHas("dialog[open]")
          .assertText("Behind the dialog");
        expect(h.app.requests.map((r) => r.method)).toEqual(["GET"]);
      });
    }, TEST_TIMEOUT);

    it("#24 a closed dialog's buttons cannot be clicked", async () => {
      await withApp(async (h) => {
        const error = await failure(h.session(FAST).visit("/dialog").clickButton("Close").clickButton("Close"));
        expect(error.message).toContain(">>> [FAILED] clickButton('Close')");
        expect(error.message).toContain("[ok] clickButton('Close')");
      });
    }, TEST_TIMEOUT);

    it("#33 labels match exactly, not as substrings", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/state")
          .fillIn("Name", "Grace")
          .assertValue("Name", "Grace")
          .assertValue("Nickname", "");
      });
    }, TEST_TIMEOUT);

    it("#35 a label that matches several controls fails the step", async () => {
      await withApp(async (h) => {
        const error = await failure(
          h.session(FAST).visit("/ambiguous").fillIn("Code", "x"),
        );
        // Which field the value was for is unknown, so it is hidden too.
        expect(error.message).toContain(`[FAILED] fillIn('Code', '${HIDDEN}')`);
        expect(error.message).toContain("2 fields are labelled 'Code'");
      });
    }, TEST_TIMEOUT);

    it("#39 assertHas with count and text, and refuteHas", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/list")
          .assertHas("li.item", { count: 2 })
          .assertHas("li.item", { text: "Two" })
          .refuteHas("li.item", { text: "Three" })
          .refuteHas("table");
      });
    }, TEST_TIMEOUT);

    it("#40 assertAttribute and refuteAttribute on a scope", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/links")
          .within("#about", (s) =>
            s.assertAttribute("href", "/about").assertAttribute("class").refuteAttribute("target"),
          );
      });
    }, TEST_TIMEOUT);

    it("#41 form state: check, uncheck, choose, selectOption and their assertions", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/state")
          .assertValue("Name", "Ada")
          .refuteChecked("Newsletter")
          .assertChecked("Terms")
          .check("Newsletter")
          .uncheck("Terms")
          .choose("Pro")
          .selectOption("Color", "Green")
          .assertChecked("Newsletter")
          .refuteChecked("Terms")
          .assertChecked("Pro")
          .refuteChecked("Free")
          .assertSelected("Color", "Green")
          .assertOptions("Color", ["Red", "Green"]);
      });
    }, TEST_TIMEOUT);

    it("#42 assertPath with queryParams, and refutePath", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/search")
          .fillIn("Query", "ada")
          .clickButton("Search")
          .assertPath("/echo", { queryParams: { q: "ada" } })
          .assertPath("/echo")
          .refutePath("/search");
      });
    }, TEST_TIMEOUT);

    it("#46 until polls until the condition holds", async () => {
      await withApp(async (h) => {
        let checks = 0;
        await h
          .session()
          .visit("/about")
          .until("the third check", () => ++checks >= 3, { interval: 20 });
        expect(checks).toBe(3);
      });
    }, TEST_TIMEOUT);

    it("#46 until fails naming the description once its budget is spent", async () => {
      await withApp(async (h) => {
        const error = await failure(
          h.session().visit("/about").until("never", () => false, { timeout: 200, interval: 20 }),
        );
        expect(error.message).toContain("[FAILED] until: never");
      });
    }, TEST_TIMEOUT);

    it("#47 until's budget defaults to the session timeout", async () => {
      await withApp(async (h) => {
        const started = Date.now();
        const error = await failure(
          h.session({ timeout: 300 }).visit("/about").until("never", () => false, { interval: 20 }),
        );
        expect(error.message).toContain("[FAILED] until: never");
        expect(Date.now() - started).toBeLessThan(2500);
      });
    }, TEST_TIMEOUT);

    it("#47 the session timeout reaches until() inside within()", async () => {
      await withApp(async (h) => {
        const started = Date.now();
        await failure(
          h
            .session({ timeout: 300 })
            .visit("/about")
            .within("h1", (s) => s.until("never", () => false, { interval: 20 })),
        );
        expect(Date.now() - started).toBeLessThan(2500);
      });
    }, TEST_TIMEOUT);

    it("#48 timeout: 0 means no limit", async () => {
      await withApp(async (h) => {
        let checks = 0;
        await h
          .session()
          .visit("/about")
          .until("the fifth check", () => ++checks >= 5, { timeout: 0, interval: 20 });
        expect(checks).toBe(5);
      });
    }, TEST_TIMEOUT);

    it("#50 a within() scope keeps working after a navigation inside it", async () => {
      await withApp(async (h) => {
        await h
          .session()
          .visit("/")
          .within("form.new-todo", (s) =>
            s
              .fillIn("What needs to be done?", "A")
              .clickButton("Add")
              .fillIn("What needs to be done?", "B")
              .clickButton("Add"),
          )
          .assertHas("li.todo", { count: 2 });
      });
    }, TEST_TIMEOUT);

    it("#8 #9 #53 run() rejects with a StepError naming the failed step", async () => {
      await withApp(async (h) => {
        const error = await failure(
          h.session(FAST).visit("/about").assertText("About").assertText("Nope").assertText("About"),
        );
        expect(error.message).toContain("[ok] visit('/about')");
        expect(error.message).toContain(">>> [FAILED] assertText('Nope')");
        expect(error.message).toContain("[skipped] assertText('About')");
      });
    }, TEST_TIMEOUT);

    it("#11 a value typed under a secret-looking label never reaches the report", async () => {
      await withApp(async (h) => {
        const error = await failure(
          h.session(FAST).visit("/login").fillIn("Password", FAKE_SECRET).assertText("Nope"),
        );
        expect(error.message).not.toContain(FAKE_SECRET);
        expect(error.message).toContain(`[ok] fillIn('Password', '${HIDDEN}')`);
      });
    }, TEST_TIMEOUT);

    it("#12 a value typed into a password field never reaches the report", async () => {
      await withApp(async (h) => {
        const error = await failure(
          h.session(FAST).visit("/codes").fillIn("Login code", FAKE_SECRET).assertText("Nope"),
        );
        expect(error.message).not.toContain(FAKE_SECRET);
        expect(error.message).toContain(`[ok] fillIn('Login code', '${HIDDEN}')`);
      });
    }, TEST_TIMEOUT);

    /** Collects onStep events as "status name". */
    function recorder() {
      const events: string[] = [];
      return {
        events,
        onStep: (e: { name: string; status: string }) => events.push(`${e.status} ${e.name}`),
      };
    }

    it("#6 #52 onStep reports every step as it starts, passes or fails, inside within() too", async () => {
      await withApp(async (h) => {
        const { events, onStep } = recorder();
        await failure(
          h
            .session({ ...FAST, onStep })
            .visit("/about")
            .within("h1", (s) => s.assertText("About"))
            .assertText("Nope"),
        );
        expect(events).toEqual([
          "started visit('/about')",
          "passed visit('/about')",
          "started within('h1')",
          "started assertText('About')",
          "passed assertText('About')",
          "passed within('h1')",
          "started assertText('Nope')",
          "failed assertText('Nope')",
        ]);
      });
    }, TEST_TIMEOUT);

    it("#13 onStep never sees a value typed into a password field", async () => {
      await withApp(async (h) => {
        const { events, onStep } = recorder();
        await h.session({ onStep }).visit("/codes").fillIn("Login code", FAKE_SECRET);
        expect(events).toContain(`started fillIn('Login code', '${HIDDEN}')`);
        expect(events).toContain(`passed fillIn('Login code', '${HIDDEN}')`);
        expect(events.join("\n")).not.toContain(FAKE_SECRET);
      });
    }, TEST_TIMEOUT);

    it("#11 a value queued but never run inside within() stays hidden", async () => {
      await withApp(async (h) => {
        const failed: unknown[] = [];
        const error = await failure(
          h
            .session({ onStep: (e) => e.status === "failed" && failed.push(e.error) })
            .visit("/codes")
            .within("form", async (s) => {
              s.fillIn("Login code", FAKE_SECRET);
            }),
        );
        expect(error.message).toContain(`fillIn('Login code', '${HIDDEN}')`);
        expect(error.message).not.toContain(FAKE_SECRET);
        expect(failed.map((e) => String((e as Error).message)).join("\n")).not.toContain(FAKE_SECRET);
      });
    }, TEST_TIMEOUT);

    it("#12 a password fill skipped after an earlier failure stays hidden", async () => {
      await withApp(async (h) => {
        const failed: string[] = [];
        const error = await failure(
          h
            .session({
              ...FAST,
              onStep: (e) => e.status === "failed" && failed.push(String((e.error as Error)?.message)),
            })
            .visit("/codes")
            .within("form", (s) => s.assertText("Nope").fillIn("Login code", FAKE_SECRET)),
        );
        expect(error.message).toContain(`[skipped] fillIn('Login code', '${HIDDEN}')`);
        expect(error.message).not.toContain(FAKE_SECRET);
        expect(failed.join("\n")).not.toContain(FAKE_SECRET);
      });
    }, TEST_TIMEOUT);

    for (const [page, label] of [
      ["/codes", "Login code"],
      ["/login", "Password"],
    ] as const) {
      it(`#12 assertValue never shows a password field's value (${label})`, async () => {
        await withApp(async (h) => {
          const events: string[] = [];
          const onStep = (e: { status: string; name: string; error?: unknown }) =>
            events.push(`${e.status} ${e.name} ${e.error ? String((e.error as Error).message) : ""}`);
          // A match: the expected value must not reach step names or events.
          await h.session({ onStep }).visit(page).fillIn(label, FAKE_SECRET).assertValue(label, FAKE_SECRET);
          expect(events).toContain(`passed assertValue('${label}', '${HIDDEN}') `);
          // A mismatch: the driver's message can carry the actual value.
          const error = await failure(
            h.session({ ...FAST, onStep }).visit(page).fillIn(label, FAKE_SECRET).assertValue(label, "wrong"),
          );
          expect(error.message).toContain(`[FAILED] assertValue('${label}', '${HIDDEN}')`);
          expect(error.message).not.toContain(FAKE_SECRET);
          expect(String((error.cause as Error)?.message ?? "")).not.toContain(FAKE_SECRET);
          expect(events.join("\n")).not.toContain(FAKE_SECRET);
        });
      }, TEST_TIMEOUT);
    }

    it("#35 assertValue on a missing field says so, and shows an empty expected value as ''", async () => {
      await withApp(async (h) => {
        const error = await failure(h.session(FAST).visit("/about").assertValue("What needs to be done?", ""));
        expect(error.message).toContain("[FAILED] assertValue('What needs to be done?', '')");
        expect(error.message).toContain(
          "no field labelled 'What needs to be done?' (or with that placeholder) was found",
        );
      });
    }, TEST_TIMEOUT);

    it("#51 within() needs exactly one match: several fail naming the count", async () => {
      await withApp(async (h) => {
        const error = await failure(h.session(FAST).visit("/list").within("li.item", (s) => s.assertText("One")));
        expect(error.message).toContain("[FAILED] within('li.item')");
        expect(error.message).toContain("matched 2 elements");
        expect(error.message).toContain("Narrow the selector");
      });
    }, TEST_TIMEOUT);

    it("#51 within() needs exactly one match: none fails naming the count", async () => {
      await withApp(async (h) => {
        const error = await failure(h.session(FAST).visit("/list").within("table", (s) => s.assertText("One")));
        expect(error.message).toContain("matched 0 elements");
      });
    }, TEST_TIMEOUT);

    it("#56 step() and raw() run inside the chain", async () => {
      await withApp(async (h) => {
        const seen: string[] = [];
        await h
          .session()
          .visit("/about")
          .step("a custom step", async (context) => {
            // Both contexts carry the native page and the current scope.
            expect(Object.keys(context as object)).toEqual(
              expect.arrayContaining(["page", "scope"]),
            );
            seen.push("step");
          })
          .raw("the native handle", (native) => {
            expect(typeof native).toBe("object");
            seen.push("raw");
          });
        expect(seen).toEqual(["step", "raw"]);
      });
    }, TEST_TIMEOUT);
  });
}
