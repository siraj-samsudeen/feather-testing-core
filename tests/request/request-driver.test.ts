// @vitest-environment node
// The request adapter must not lean on a global DOM: it brings its own parser.
import { describe, it, expect, vi } from "vitest";
import { RequestDriver } from "../../src/request/driver.js";
import { createSession } from "../../src/request/index.js";
import { BrowserOnlyVerbError, StepError } from "../../src/errors.js";
import { createFixtureApp } from "./fixture-app.js";

const AVATAR = new URL("./files/avatar.png", import.meta.url).pathname;
const NOTES = new URL("./files/notes.txt", import.meta.url).pathname;

/** The `<li>` lines /echo rendered, i.e. what the "browser" sent. */
async function echoed(driver: RequestDriver): Promise<string[]> {
  let lines: string[] = [];
  await driver.raw((page) => {
    lines = Array.from(page.document.querySelectorAll("#entries li")).map(
      (li) => li.textContent ?? "",
    );
  });
  return lines;
}

function driverFor(pages: Parameters<typeof createFixtureApp>[0] = {}) {
  const app = createFixtureApp(pages);
  return { app, driver: new RequestDriver(app.handle) };
}

describe("RequestDriver", () => {
  describe("visit()", () => {
    it("GETs the path through the handler and parses the page", async () => {
      const { app, driver } = driverFor({ "/hello": "<h1>Hello there</h1>" });
      await driver.visit("/hello");
      await driver.assertText("Hello there");
      expect(app.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET http://localhost/hello",
      ]);
    });
  });

  describe("assertText() / refuteText()", () => {
    const page = `
      <h1>Shopping
        list</h1>
      <p>Buy <b>oat</b> milk</p>
      <script>var secret = "in a script"</script>
      <style>.x { content: "in a style" }</style>
      <template><p>in a template</p></template>
      <div hidden><p>in a hidden div</p></div>
      <noscript>in noscript</noscript>`;

    it("matches a whitespace-normalized substring, across inline elements", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.assertText("Shopping list");
      await driver.assertText("oat milk");
      await driver.assertText("Buy oat");
    });

    it("ignores case, like Playwright's getByText", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.assertText("SHOPPING LIST");
    });

    it("does not see text a browser would not render", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      for (const hidden of [
        "in a script",
        "in a style",
        "in a template",
        "in a hidden div",
        "in noscript",
      ]) {
        await expect(driver.assertText(hidden)).rejects.toThrow(
          `assertText('${hidden}')`,
        );
        await driver.refuteText(hidden);
      }
    });

    it("names the page in the failure", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await expect(driver.assertText("Bread")).rejects.toThrow(
        /assertText\('Bread'\): no text matching 'Bread' on GET http:\/\/localhost\/ \(200\)[\s\S]*Shopping list/,
      );
    });

    it("refuteText fails when the text is present", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await expect(driver.refuteText("oat milk")).rejects.toThrow(
        "refuteText('oat milk'): expected no text matching 'oat milk', but found it",
      );
    });

    it("fails clearly before any page is loaded", async () => {
      const { driver } = driverFor();
      await expect(driver.assertText("x")).rejects.toThrow(
        "No page loaded yet: start the chain with visit(path).",
      );
    });
  });

  describe("assertExactText()", () => {
    it("compares the scope's whole normalized text, case-sensitively", async () => {
      const { driver } = driverFor({
        "/": `<p class="total">  Total:\n 1 </p>`,
      });
      await driver.visit("/");
      const total = await driver.within(".total");
      await total.assertExactText("Total: 1");
      await expect(total.assertExactText("Total: 10")).rejects.toThrow(
        "assertExactText('Total: 10'): expected normalized text 'Total: 10', but found 'Total: 1'.",
      );
      await expect(total.assertExactText("total: 1")).rejects.toThrow();
    });
  });

  describe("redirects", () => {
    // What the browser's fetch does with the method and body at each status.
    it.each([
      [301, "GET"],
      [302, "GET"],
      [303, "GET"],
      [307, "POST"],
      [308, "POST"],
    ])("a %i after a POST is followed with %s", async (status, method) => {
      const { driver } = driverFor({
        "/form": `<form method="post" action="/redirect/${status}?from=form">
            <input name="q" value="kept?"><button>Send</button></form>`,
      });
      await driver.visit("/form");
      await driver.clickButton("Send");
      await driver.assertPath("/echo");
      const echo = await driver.within("#method");
      await echo.assertExactText(method);
      if (method === "POST") {
        await driver.assertText("body q=kept?");
      } else {
        await driver.refuteText("body q=");
      }
      // The Location's query survives every hop.
      await driver.assertText("query from=form");
    });

    it("a 303 after a GET stays a GET", async () => {
      const { driver } = driverFor();
      await driver.visit("/redirect/303?x=1");
      await driver.assertPath("/echo", { queryParams: { x: "1" } });
    });

    it("gives up on a redirect loop instead of hanging", async () => {
      const { driver } = driverFor();
      await expect(driver.visit("/redirect-loop")).rejects.toThrow(
        "visit('/redirect-loop'): more than 20 redirects, last to http://localhost/redirect-loop",
      );
    });
  });

  describe("cookies", () => {
    it("keeps Set-Cookie across redirects and later requests, and honours Path and Max-Age", async () => {
      const { driver } = driverFor();
      await driver.visit("/dashboard");
      await driver.assertPath("/login");
      await driver.fillIn("Email", "ada@example.com");
      await driver.fillIn("Password", "hunter2");
      await driver.clickButton("Sign in");
      await driver.assertPath("/dashboard");
      await driver.assertText("Signed in as ada@example.com");
      // flash has Path=/dashboard, so it reached the dashboard...
      await driver.assertText("Welcome");
      // ...but not /echo.
      await driver.visit("/echo");
      const cookie = await driver.within("#cookie");
      await cookie.assertExactText("session=ada%40example.com");
      // Max-Age=0 deletes it.
      await driver.visit("/logout");
      await driver.assertPath("/login");
      await driver.visit("/echo");
      await (await driver.within("#cookie")).assertExactText("");
    });

    it("sends cookies only to the host that set them", async () => {
      const seen: string[] = [];
      const driver = new RequestDriver(
        async (request) => {
          seen.push(
            `${new URL(request.url).host}:${request.headers.get("cookie") ?? ""}`,
          );
          const response = new Response("<p>ok</p>", {
            headers: { "content-type": "text/html" },
          });
          if (new URL(request.url).host === "a.test") {
            response.headers.append("set-cookie", "a=1");
            response.headers.append("set-cookie", "shared=1; Domain=test");
          }
          return response;
        },
        { baseUrl: "http://a.test" },
      );
      await driver.visit("/");
      await driver.visit("/");
      await driver.visit("http://b.test/");
      await driver.visit("http://sub.a.test/");
      expect(seen).toEqual([
        "a.test:",
        "a.test:a=1; shared=1",
        "b.test:shared=1",
        "sub.a.test:shared=1",
      ]);
    });
  });

  describe("assertPath() / refutePath()", () => {
    it("compares the current URL's pathname exactly", async () => {
      const { driver } = driverFor({ "/re/import": "<p>x</p>" });
      await driver.visit("/re/import?tab=2");
      await driver.assertPath("/re/import");
      await expect(driver.assertPath("/import")).rejects.toThrow(
        "assertPath('/import'): expected path '/import', but the current URL is http://localhost/re/import?tab=2",
      );
      await driver.refutePath("/import");
      await expect(driver.refutePath("/re/import")).rejects.toThrow(
        "refutePath('/re/import'): expected not to be on '/re/import', but the current URL is http://localhost/re/import?tab=2",
      );
    });

    it("with queryParams, requires exactly those query parameters", async () => {
      const { driver } = driverFor({ "/search": "<p>x</p>" });
      await driver.visit("/search?q=hello&page=1");
      await driver.assertPath("/search", {
        queryParams: { q: "hello", page: "1" },
      });
      await expect(
        driver.assertPath("/search", { queryParams: { q: "hello" } }),
      ).rejects.toThrow("assertPath('/search')");
    });

    it("resolves visit() paths against the base URL, including its base path", async () => {
      const app = createFixtureApp();
      const driver = new RequestDriver(app.handle, {
        baseUrl: "http://example.test/app/",
      });
      await driver.visit("echo");
      expect(app.requests[0].url).toBe("http://example.test/app/echo");
      await driver.assertPath("/app/echo");
    });
  });

  describe("reload()", () => {
    it("fetches the current URL again and shows the new page", async () => {
      const { driver } = driverFor();
      await driver.visit("/counter?x=1");
      await driver.assertText("Count: 1");
      await driver.reload();
      await driver.assertText("Count: 2");
      await driver.assertPath("/counter", { queryParams: { x: "1" } });
    });

    it("resends a POST that rendered a page, as a browser's reload does", async () => {
      const { app, driver } = driverFor({
        "/form": `<form method="post" action="/echo"><input name="a" value="1"><button>Go</button></form>`,
      });
      await driver.visit("/form");
      await driver.clickButton("Go");
      await driver.reload();
      expect(app.requests.map((r) => r.method)).toEqual([
        "GET",
        "POST",
        "POST",
      ]);
      await driver.assertText("body a=1");
    });
  });

  describe("form submission", () => {
    const lab = `
      <form method="post" action="/echo">
        <label for="name">Name</label><input id="name" name="name" value="default name">
        <input name="untouched" value="sent as is">
        <input value="no name, not sent">
        <input name="off" value="disabled, not sent" disabled>
        <fieldset disabled><input name="in-disabled-fieldset" value="x"></fieldset>
        <fieldset disabled><legend><input name="in-first-legend" value="sent"></legend></fieldset>
        <input type="hidden" name="token" value="abc">
        <input type="hidden" name="_charset_">
        <label><input type="checkbox" name="agree"> Agree</label>
        <label><input type="checkbox" name="tags" value="a" checked> Tag A</label>
        <label><input type="checkbox" name="tags" value="b" checked> Tag B</label>
        <label><input type="radio" name="size" value="s"> Small</label>
        <label><input type="radio" name="size" value="m" checked> Medium</label>
        <label for="color">Color</label>
        <select id="color" name="color"><option value="r">Red</option><option>Green</option></select>
        <label for="multi">Multi</label>
        <select id="multi" name="multi" multiple><option selected>A</option><option>B</option><option selected disabled>C</option></select>
        <label for="bio">Bio</label><textarea id="bio" name="bio">line one
line two</textarea>
        <datalist><input name="in-datalist" value="x"></datalist>
        <button type="button" name="js" value="never">JS only</button>
        <button type="reset">Reset</button>
        <button name="action" value="save">Save</button>
        <button name="action" value="publish">Publish</button>
        <input type="submit" value="Plain submit">
      </form>
      <input form="outside-owner" name="owned-from-outside" value="x">`;

    it("sends successful controls only, with their default values, in tree order", async () => {
      const { driver } = driverFor({ "/lab": lab });
      await driver.visit("/lab");
      await driver.clickButton("Save");
      expect(await echoed(driver)).toEqual([
        "body name=default name",
        "body untouched=sent as is",
        "body in-first-legend=sent",
        "body token=abc",
        "body _charset_=UTF-8",
        "body tags=a",
        "body tags=b",
        "body size=m",
        "body color=r",
        "body multi=A",
        "body bio=line one\r\nline two",
        "body action=save",
      ]);
    });

    it("sends only the clicked submit button's name and value", async () => {
      const { driver } = driverFor({ "/lab": lab });
      await driver.visit("/lab");
      await driver.clickButton("Publish");
      expect(await echoed(driver)).toContain("body action=publish");
      expect(await echoed(driver)).not.toContain("body action=save");
      await driver.visit("/lab");
      await driver.clickButton("Plain submit");
      expect(
        (await echoed(driver)).filter((l) => l.startsWith("body action")),
      ).toEqual([]);
    });

    it("sends what the verbs changed", async () => {
      const { driver } = driverFor({ "/lab": lab });
      await driver.visit("/lab");
      await driver.fillIn("Name", "Ada");
      await driver.check("Agree");
      await driver.uncheck("Tag A");
      await driver.choose("Small");
      await driver.selectOption("Color", "Green");
      await driver.selectOption("Multi", "B");
      await driver.fillIn("Bio", "new bio");
      await driver.clickButton("Save");
      const sent = await echoed(driver);
      expect(sent).toEqual(
        expect.arrayContaining([
          "body name=Ada",
          "body agree=on",
          "body size=s",
          "body color=Green",
          "body multi=B",
          "body bio=new bio",
        ]),
      );
      expect(sent).not.toContain("body tags=a");
      expect(sent).not.toContain("body size=m");
      expect(sent).not.toContain("body multi=A");
    });

    it("a reset button restores every control's default", async () => {
      const { driver } = driverFor({ "/lab": lab });
      await driver.visit("/lab");
      await driver.fillIn("Name", "Ada");
      await driver.check("Agree");
      await driver.selectOption("Color", "Green");
      await driver.clickButton("Reset");
      await driver.assertValue("Name", "default name");
      await driver.refuteChecked("Agree");
      await driver.assertSelected("Color", "Red");
    });

    it("a type=button button has no form behaviour, so it is browser-only", async () => {
      const { driver } = driverFor({ "/lab": lab });
      await driver.visit("/lab");
      const error = await driver
        .clickButton("JS only")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BrowserOnlyVerbError);
      expect((error as Error).message).toContain("clickButton('JS only')");
    });

    it('sends a form-associated control outside the form (form="id")', async () => {
      const { driver } = driverFor({
        "/": `<form id="f" method="post" action="/echo"><button>Go</button></form>
              <input form="f" name="outside" value="yes">`,
      });
      await driver.visit("/");
      await driver.clickButton("Go");
      expect(await echoed(driver)).toEqual(["body outside=yes"]);
    });

    it("encodes as application/x-www-form-urlencoded and sends Origin", async () => {
      const { app, driver } = driverFor({
        "/": `<form method="post" action="/echo"><input name="q" value="a b&c=d"><button>Go</button></form>`,
      });
      await driver.visit("/");
      await driver.clickButton("Go");
      const sent = app.requests[1];
      expect(sent.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(await sent.text()).toBe("q=a+b%26c%3Dd");
      expect(sent.headers.get("origin")).toBe("http://localhost");
    });

    it("a GET form replaces the action's query string and keeps no body", async () => {
      const { app, driver } = driverFor({
        "/": `<form action="/echo?old=1#frag"><label>Search <input name="q"></label><button>Search</button></form>`,
      });
      await driver.visit("/");
      await driver.fillIn("Search", "phoenix test");
      await driver.clickButton("Search");
      expect(app.requests[1].url).toBe(
        "http://localhost/echo?q=phoenix+test#frag",
      );
      await driver.assertPath("/echo", { queryParams: { q: "phoenix test" } });
    });

    it("a missing or empty action submits to the current URL", async () => {
      const { app, driver } = driverFor({
        "/form": `<form method="post"><button>Missing</button></form>
                  <form method="post" action=""><button>Empty</button></form>`,
      });
      await driver.visit("/form?keep=1");
      await driver.clickButton("Missing");
      await driver.visit("/form?keep=2");
      await driver.clickButton("Empty");
      expect(app.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET http://localhost/form?keep=1",
        "POST http://localhost/form?keep=1",
        "GET http://localhost/form?keep=2",
        "POST http://localhost/form?keep=2",
      ]);
    });

    it("resolves the action against <base href>", async () => {
      const { app, driver } = driverFor({
        "/deep/page": `<base href="/echo/"><form method="post" action="target"><button>Go</button></form>`,
      });
      await driver.visit("/deep/page");
      await driver.clickButton("Go");
      expect(app.requests[1].url).toBe("http://localhost/echo/target");
    });

    it("the submitter's formaction, formmethod and formenctype win", async () => {
      const { app, driver } = driverFor({
        "/": `<form method="post" action="/nowhere"><input name="a" value="1">
                <button formaction="/echo" formmethod="get">As GET</button>
                <button formaction="/echo" formenctype="multipart/form-data">As multipart</button>
                <button formaction="/echo" formenctype="text/plain">As text</button></form>`,
      });
      await driver.visit("/");
      await driver.clickButton("As GET");
      expect(app.requests[1].url).toBe("http://localhost/echo?a=1");
      await driver.visit("/");
      await driver.clickButton("As multipart");
      await driver.assertText("multipart/form-data");
      expect(await echoed(driver)).toEqual(["body a=1"]);
      await driver.visit("/");
      await driver.clickButton("As text");
      // text/plain is one "name=value" line per entry, CRLF-terminated.
      expect(await echoed(driver)).toEqual(["raw a=1\r\n"]);
    });

    it("refuses to submit a form with an empty required field, as a browser would", async () => {
      const { app, driver } = driverFor({
        "/": `<form method="post" action="/echo"><label>Title <input name="title" required></label><button>Add</button></form>
              <form method="post" action="/echo" novalidate><label>Other <input name="o" required></label><button>Skip checks</button></form>`,
      });
      await driver.visit("/");
      await expect(driver.clickButton("Add")).rejects.toThrow(
        "clickButton('Add'): a browser would not submit this form: 'Title' is required but empty.",
      );
      expect(app.requests).toHaveLength(1);
      await driver.clickButton("Skip checks");
      await driver.assertPath("/echo");
    });

    it("refuses a disabled submit button", async () => {
      const { driver } = driverFor({
        "/": `<form method="post" action="/echo"><button disabled>Save</button></form>`,
      });
      await driver.visit("/");
      await expect(driver.clickButton("Save")).rejects.toThrow(
        "clickButton('Save'): the button is disabled.",
      );
    });
  });

  describe("attachFile()", () => {
    const upload = `
      <form method="post" action="/echo" enctype="multipart/form-data">
        <label for="avatar">Avatar</label><input type="file" id="avatar" name="avatar">
        <label for="notes">Notes</label><input type="file" id="notes" name="notes">
        <input name="caption" value="me">
        <button>Upload</button>
      </form>
      <form method="post" action="/echo">
        <label for="plain">Plain</label><input type="file" id="plain" name="plain">
        <button>Upload urlencoded</button>
      </form>`;

    it("sends the file's bytes, name and type as multipart/form-data", async () => {
      const { app, driver } = driverFor({ "/": upload });
      await driver.visit("/");
      await driver.attachFile("Avatar", AVATAR);
      await driver.clickButton("Upload");
      await driver.assertText("multipart/form-data");
      expect(await echoed(driver)).toEqual([
        "body avatar=file:avatar.png:image/png:12:hello avatar",
        // An empty file input is sent as a nameless empty file.
        "body notes=file::application/octet-stream:0:",
        "body caption=me",
      ]);
      const raw = await app.requests[1].text();
      expect(raw).toContain(
        'Content-Disposition: form-data; name="notes"; filename=""\r\nContent-Type: application/octet-stream',
      );
    });

    it("sends only the file name when the form is urlencoded", async () => {
      const { driver } = driverFor({ "/": upload });
      await driver.visit("/");
      await driver.attachFile("Plain", NOTES);
      await driver.clickButton("Upload urlencoded");
      expect(await echoed(driver)).toEqual(["body plain=notes.txt"]);
    });

    it("upload() still works as the deprecated alias", async () => {
      const { driver } = driverFor({ "/": upload });
      await driver.visit("/");
      await driver.upload("Notes", NOTES);
      await driver.clickButton("Upload");
      expect(await echoed(driver)).toContain(
        "body notes=file:notes.txt:text/plain:4:col\n",
      );
    });

    it("rejects a field that is not a file input", async () => {
      const { driver } = driverFor({
        "/": `<label>Name <input name="n"></label>`,
      });
      await driver.visit("/");
      await expect(driver.attachFile("Name", NOTES)).rejects.toThrow(
        "attachFile('Name'): the field labelled 'Name' is an <input type=\"text\">, not a file input.",
      );
    });
  });

  describe("clickLink()", () => {
    const links = `
      <nav><a href="/echo/a">Home</a> <a href="../echo/b?x=1">Relative</a>
        <a href="/echo/c" aria-label="Settings"><svg></svg></a>
        <a href="/echo/d"><img src="x.png" alt="Logo"></a>
        <a href="/echo/e">Home page</a>
        <a>No href</a>
        <a href="#details">Details</a></nav>
      <ul><li><a href="/echo/1">Edit</a></li><li><a href="/echo/2">Edit</a></li></ul>`;

    it("follows the href of the link with exactly this name", async () => {
      const { driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await driver.clickLink("Home");
      await driver.assertPath("/echo/a");
    });

    it("resolves a relative href against the current page", async () => {
      const { driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await driver.clickLink("Relative");
      await driver.assertPath("/echo/b", { queryParams: { x: "1" } });
    });

    it("names a link by aria-label or by its image's alt", async () => {
      const { driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await driver.clickLink("Settings");
      await driver.assertPath("/echo/c");
      await driver.visit("/dir/page");
      await driver.clickLink("Logo");
      await driver.assertPath("/echo/d");
    });

    it("a same-page #fragment link changes only the URL's hash", async () => {
      const { app, driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await driver.clickLink("Details");
      expect(app.requests).toHaveLength(1);
      await driver.raw((page) =>
        expect(page.url.href).toBe("http://localhost/dir/page#details"),
      );
    });

    it("lists the links on the page when none has the name", async () => {
      const { driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await expect(driver.clickLink("Hom")).rejects.toThrow(
        "clickLink('Hom'): no link named 'Hom' on GET http://localhost/dir/page (200). Links here: 'Home', 'Relative', 'Settings', 'Logo', 'Home page', 'Details', 'Edit'.",
      );
    });

    it("refuses an ambiguous name, like Playwright's strict mode", async () => {
      const { driver } = driverFor({ "/dir/page": links });
      await driver.visit("/dir/page");
      await expect(driver.clickLink("Edit")).rejects.toThrow(
        "clickLink('Edit'): 2 links are named 'Edit'",
      );
      const second = await driver.within("li:nth-child(2)");
      await second.clickLink("Edit");
      await driver.assertPath("/echo/2");
    });
  });

  describe("click()", () => {
    const page = `
      <a href="/echo/link">Go <b>there</b></a>
      <form method="post" action="/echo"><button name="b" value="1"><span>Press</span> me</button></form>
      <label><input type="checkbox" name="c"> Remember me</label>
      <p>Just text</p>
      <button type="button" onclick="x()">Scripted</button>`;

    it("follows a link found by its text", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.click("Go there");
      await driver.assertPath("/echo/link");
    });

    it("presses the button whose text it is, even from an inner element", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.click("Press");
      expect(await echoed(driver)).toEqual(["body b=1"]);
    });

    it("clicking a label toggles its control", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.click("Remember me");
      await driver.assertChecked("Remember me");
      await driver.click("Remember me");
      await driver.refuteChecked("Remember me");
    });

    it("text that is no link, button or label is browser-only", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      const error = await driver.click("Just text").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BrowserOnlyVerbError);
      expect((error as Error).message).toContain(
        "plain HTTP requests and parsed HTML",
      );
      await expect(driver.click("Scripted")).rejects.toBeInstanceOf(
        BrowserOnlyVerbError,
      );
    });

    it("fails when no element has exactly this text", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await expect(driver.click("Just")).rejects.toThrow(
        "click('Just'): no element with the text 'Just' on GET http://localhost/ (200).",
      );
    });
  });

  describe("finding fields", () => {
    const form = `
      <form>
        <label for="name">Name</label><input id="name" name="name">
        <input name="nickname" placeholder="Nickname">
        <input name="search" aria-label="Search the site">
        <span id="qty-label">Quantity</span><input name="qty" aria-labelledby="qty-label">
        <label>Plan <select name="plan"><option>Free</option><option>Pro</option></select></label>
        <label for="locked">Locked</label><input id="locked" value="x" readonly>
        <label for="off">Off</label><input id="off" disabled>
        <label><input type="checkbox" name="tos"> Terms</label>
        <label><input type="radio" name="r" value="1"> Radio</label>
        <div class="billing"><label for="b-city">City</label><input id="b-city"></div>
        <div class="shipping"><label for="s-city">City</label><input id="s-city"></div>
      </form>`;

    it("matches a label exactly, so 'Name' never reaches 'Nickname'", async () => {
      const { driver } = driverFor({ "/": form });
      await driver.visit("/");
      await driver.fillIn("Name", "Ada");
      await driver.assertValue("Name", "Ada");
      await driver.assertValue("Nickname", "");
      await expect(driver.fillIn("name", "x")).rejects.toThrow(
        "fillIn('name'): no field labelled 'name' (or with that placeholder)",
      );
    });

    it("falls back to the placeholder, then aria-label and aria-labelledby count as labels", async () => {
      const { driver } = driverFor({ "/": form });
      await driver.visit("/");
      await driver.fillIn("Nickname", "ada");
      await driver.fillIn("Search the site", "q");
      await driver.fillIn("Quantity", "2");
      await driver.assertValue("Nickname", "ada");
      await driver.assertValue("Search the site", "q");
      await driver.assertValue("Quantity", "2");
    });

    it("a wrapping label is named without its select's options", async () => {
      const { driver } = driverFor({ "/": form });
      await driver.visit("/");
      await driver.selectOption("Plan", "Pro");
      await driver.assertSelected("Plan", "Pro");
      await driver.assertOptions("Plan", ["Free", "Pro"]);
      await expect(driver.assertOptions("Plan", ["Free"])).rejects.toThrow(
        "assertOptions('Plan'): expected options [Free], but found [Free, Pro].",
      );
      await expect(driver.selectOption("Plan", "Gold")).rejects.toThrow(
        "selectOption('Plan', 'Gold'): no <option> labelled 'Gold'. Options: 'Free', 'Pro'.",
      );
    });

    it("refuses an ambiguous label and lets within() pick", async () => {
      const { driver } = driverFor({ "/": form });
      await driver.visit("/");
      await expect(driver.fillIn("City", "Paris")).rejects.toThrow(
        "fillIn('City'): 2 fields are labelled 'City'",
      );
      const shipping = await driver.within(".shipping");
      await shipping.fillIn("City", "Paris");
      await shipping.assertValue("City", "Paris");
    });

    it("refuses read-only, disabled and wrong-kind fields", async () => {
      const { driver } = driverFor({ "/": form });
      await driver.visit("/");
      await expect(driver.fillIn("Locked", "y")).rejects.toThrow(
        "fillIn('Locked'): the field is read-only.",
      );
      await expect(driver.fillIn("Off", "y")).rejects.toThrow(
        "fillIn('Off'): the field is disabled.",
      );
      await expect(driver.fillIn("Terms", "y")).rejects.toThrow(
        `fillIn('Terms'): the field labelled 'Terms' is an <input type="checkbox">, which cannot be typed into.`,
      );
      await expect(driver.check("Name")).rejects.toThrow(
        `check('Name'): the field labelled 'Name' is an <input type="text">, not a checkbox or radio button.`,
      );
      await expect(driver.uncheck("Radio")).rejects.toThrow(
        `uncheck('Radio'): the field labelled 'Radio' is an <input type="radio">, not a checkbox.`,
      );
      await expect(driver.choose("Terms")).rejects.toThrow(
        "not a radio button",
      );
      await expect(driver.selectOption("Name", "x")).rejects.toThrow(
        "not a <select>",
      );
    });

    it("lists the fields there are when none matches", async () => {
      const { driver } = driverFor({
        "/": `<label for="e">Email</label><input id="e"><input placeholder="Code">`,
      });
      await driver.visit("/");
      await expect(driver.fillIn("Emial", "x")).rejects.toThrow(
        "fillIn('Emial'): no field labelled 'Emial' (or with that placeholder) on GET http://localhost/ (200). Fields here: 'Email', 'Code'.",
      );
    });

    it("lastFilledFieldIsPassword() reports the field the last fillIn() targeted", async () => {
      const { driver } = driverFor();
      await driver.visit("/login");
      await driver.fillIn("Email", "a@b.c");
      expect(await driver.lastFilledFieldIsPassword()).toBe(false);
      await driver.fillIn("Password", "pw");
      expect(await driver.lastFilledFieldIsPassword()).toBe(true);
      await expect(driver.fillIn("Nope", "pw")).rejects.toThrow(
        "fillIn('Nope'): no field labelled 'Nope'",
      );
      expect(await driver.lastFilledFieldIsPassword()).toBe(false);
    });
  });

  describe("submit()", () => {
    it("submits the last form a verb touched, through its type=submit button", async () => {
      const { driver } = driverFor({
        "/": `<form method="post" action="/echo/other"><label>Other <input name="o"></label><button type="submit" name="b" value="other">Go</button></form>
              <form method="post" action="/echo/mine"><label>Mine <input name="m"></label>
                <button name="first" value="1">Not explicit</button>
                <input type="submit" name="explicit" value="Explicit"></form>`,
      });
      await driver.visit("/");
      await driver.fillIn("Mine", "x");
      await driver.submit();
      await driver.assertPath("/echo/mine");
      expect(await echoed(driver)).toEqual([
        "body m=x",
        "body explicit=Explicit",
      ]);
    });

    it("falls back to a button whose name contains 'submit', then to implicit submission", async () => {
      const { driver } = driverFor({
        "/named": `<form method="post" action="/echo"><label>A <input name="a"></label><button name="b" value="named">Submit order</button></form>`,
        "/implicit": `<form method="post" action="/echo"><label>A <input name="a"></label></form>`,
      });
      await driver.visit("/named");
      await driver.fillIn("A", "1");
      await driver.submit();
      expect(await echoed(driver)).toEqual(["body a=1", "body b=named"]);
      await driver.visit("/implicit");
      await driver.fillIn("A", "2");
      await driver.submit();
      expect(await echoed(driver)).toEqual(["body a=2"]);
    });

    it("throws when no form was touched, or the form left with its page", async () => {
      const { driver } = driverFor();
      await driver.visit("/login");
      await expect(driver.submit()).rejects.toThrow(
        "submit() called but no form was previously interacted with.",
      );
      await driver.fillIn("Email", "a@b.c");
      await driver.visit("/echo");
      await expect(driver.submit()).rejects.toThrow(
        "submit(): the form last interacted with is not on the current page any more.",
      );
    });
  });

  describe("pressKey()", () => {
    it("Enter in a field submits its form implicitly, through its default button", async () => {
      const { driver } = driverFor();
      await driver.visit("/");
      await driver.fillIn("What needs to be done?", "Read the guide");
      await driver.pressKey("Enter");
      await driver.assertPath("/");
      await driver.assertText("Read the guide");
    });

    it("Enter does nothing in a form with no submit button and several text fields", async () => {
      const { app, driver } = driverFor({
        "/": `<form method="post" action="/echo"><label>A <input name="a"></label><label>B <input name="b"></label></form>`,
      });
      await driver.visit("/");
      await driver.fillIn("A", "1");
      await expect(driver.pressKey("Enter")).rejects.toThrow(
        "pressKey('Enter'): a browser would not submit this form: it has no submit button and more than one text field.",
      );
      expect(app.requests).toHaveLength(1);
    });

    it("Enter in a textarea types a newline", async () => {
      const { driver } = driverFor({
        "/": `<label>Bio <textarea name="bio"></textarea></label>`,
      });
      await driver.visit("/");
      await driver.fillIn("Bio", "one");
      await driver.pressKey("Enter");
      await driver.assertValue("Bio", "one\n");
    });

    it("focus does not survive a navigation", async () => {
      const { driver } = driverFor({
        "/": `<a href="/echo/linked">Linked</a>`,
      });
      await driver.visit("/");
      await driver.click("Linked");
      await driver.assertPath("/echo/linked");
      await expect(driver.pressKey("Enter")).rejects.toThrow(
        "pressKey('Enter'): nothing has focus.",
      );
    });

    it("any other key is browser-only", async () => {
      const { driver } = driverFor();
      await driver.visit("/");
      await driver.fillIn("What needs to be done?", "x");
      for (const key of ["Escape", "a", "Control+A", "Tab"]) {
        const error = await driver.pressKey(key).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BrowserOnlyVerbError);
        expect((error as Error).message).toContain(`pressKey('${key}')`);
      }
    });
  });

  describe("assertHas() / refuteHas()", () => {
    const page = `<ul class="todo-list">
        <li class="todo">Buy milk</li><li class="todo done">Walk the dog</li><li class="todo" hidden>Ghost</li>
      </ul>`;

    it("asserts a rendered element matches the selector", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.assertHas("li.todo");
      await driver.refuteHas(".spinner");
      await expect(driver.assertHas(".spinner")).rejects.toThrow(
        "assertHas('.spinner'): no rendered element matches '.spinner' on GET http://localhost/ (200).",
      );
    });

    it("count and refuteHas count every match, rendered or not, like Playwright's toHaveCount", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.assertHas("li.todo", { count: 3 });
      await expect(driver.assertHas("li.todo", { count: 2 })).rejects.toThrow(
        "assertHas('li.todo'): expected 2 elements matching 'li.todo', but found 3.",
      );
      await expect(driver.refuteHas("li", { text: "Ghost" })).rejects.toThrow(
        "refuteHas('li'): expected no element matching 'li' with text 'Ghost', but found 1.",
      );
      await expect(driver.assertHas("li", { text: "Ghost" })).rejects.toThrow(
        "assertHas('li'): no rendered element matches 'li' with text 'Ghost'",
      );
    });

    it("filters by text: a regex by default, a case-insensitive substring with exact", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await driver.assertHas("li", { text: "^Buy" });
      await driver.assertHas("li", { text: "walk the", exact: true });
      await driver.refuteHas("li", { text: "^milk" });
      await expect(driver.refuteHas("li", { text: "milk" })).rejects.toThrow(
        "refuteHas('li'): expected no element matching 'li' with text 'milk', but found 1.",
      );
    });
  });

  describe("assertAttribute() / refuteAttribute()", () => {
    it("checks the scope element's attributes; unscoped, that is <body>", async () => {
      const { driver } = driverFor({
        "/": `<div id="root" data-palette="ivory" data-ready data-empty="">x</div>`,
      });
      await driver.visit("/");
      const root = await driver.within("#root");
      await root.assertAttribute("data-palette", "ivory");
      await root.assertAttribute("data-ready");
      await root.assertAttribute("data-empty", "");
      await root.refuteAttribute("data-loading");
      await expect(root.assertAttribute("data-palette", "ink")).rejects.toThrow(
        "assertAttribute('data-palette'): expected attribute 'data-palette' to equal 'ink', but found 'ivory'.",
      );
      await expect(root.assertAttribute("data-loading")).rejects.toThrow(
        "assertAttribute('data-loading'): expected attribute 'data-loading' to be present, but found <missing>.",
      );
      await expect(root.refuteAttribute("data-ready")).rejects.toThrow(
        "refuteAttribute('data-ready'): expected attribute 'data-ready' to be absent, but found ''.",
      );
      await driver.refuteAttribute("data-palette");
    });

    it("an unscoped within() resolves from the document root, so 'html' works", async () => {
      const { driver } = driverFor({
        "/": () =>
          new Response(
            `<!doctype html><html lang="en" data-theme="dark"><body>x</body></html>`,
            { headers: { "content-type": "text/html" } },
          ),
      });
      await driver.visit("/");
      const html = await driver.within("html");
      await html.assertAttribute("data-theme", "dark");
    });
  });

  describe("within()", () => {
    const page = `
      <section class="billing"><h2>Billing</h2><div class="row"><span>Total</span> <a href="/echo/billing">Edit</a></div></section>
      <section class="shipping"><h2>Shipping</h2><div class="row"><span>Total</span> <a href="/echo/shipping">Edit</a></div></section>`;

    it("nests: each scope narrows the one it was made in", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      const shipping = await driver.within(".shipping");
      await shipping.assertText("Shipping");
      await shipping.refuteText("Billing");
      const row = await shipping.within(".row");
      await row.assertExactText("Total Edit");
      await row.clickLink("Edit");
      await driver.assertPath("/echo/shipping");
    });

    it("fails at within() when the selector matches nothing, or more than one element", async () => {
      const { driver } = driverFor({ "/": page });
      await driver.visit("/");
      await expect(driver.within(".nope")).rejects.toThrow(
        "within('.nope'): expected exactly one element, but found 0 on GET http://localhost/ (200).",
      );
      await expect(driver.within("section")).rejects.toThrow(
        "within('section'): expected exactly one element, but found 2",
      );
    });

    it("re-resolves against the new page after a navigation inside it", async () => {
      const { driver } = driverFor();
      await driver.visit("/");
      const newTodo = await driver.within("form.new-todo");
      await newTodo.fillIn("What needs to be done?", "First");
      await newTodo.clickButton("Add");
      // Same scope, new document: the form is the re-rendered one, empty again.
      await newTodo.assertValue("What needs to be done?", "");
      await newTodo.fillIn("What needs to be done?", "Second");
      await newTodo.clickButton("Add");
      await driver.assertHas("li.todo", { count: 2 });
      const second = await driver.within("#todo-2");
      await second.clickButton("Done");
      await driver.assertHas("li.todo.completed", { text: "Second" });
      await (await driver.within(".count")).assertExactText("1 items left");
    });
  });

  describe("step() / raw()", () => {
    it("step() gets the current page, the scope, and a fetch that carries the session's cookies", async () => {
      const { driver } = driverFor();
      await driver.visit("/login");
      await driver.fillIn("Email", "ada@example.com");
      await driver.clickButton("Sign in");
      const scoped = await driver.within("h1");
      await scoped.step(async ({ page, scope, fetch }) => {
        expect(page.url.pathname).toBe("/dashboard");
        expect(scope.textContent).toBe("Dashboard");
        const response = await fetch("/echo");
        const body = await response.text();
        expect(body).toContain("session=ada%40example.com");
      });
      // fetch() did not navigate.
      await driver.assertPath("/dashboard");
    });

    it("raw() hands over the document, a readable clone of the last response, the URL and body", async () => {
      const { driver } = driverFor();
      await driver.visit("/about");
      await driver.raw(async ({ document, response, url, body }) => {
        expect(document.querySelector("h1")?.textContent).toBe("About");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toBe(body);
        expect(url.href).toBe("http://localhost/about");
      });
      // Each raw() gets its own clone, so the body can be read again.
      await driver.raw(async ({ response }) => {
        expect(await response.text()).toContain("<h1>About</h1>");
      });
    });

    it("raw() shows the status of an error page", async () => {
      const { driver } = driverFor();
      await driver.visit("/missing");
      await driver.assertText("Not found");
      await driver.raw(({ response }) => expect(response.status).toBe(404));
    });
  });

  describe("until()", () => {
    it("re-fetches a GET page between checks until the condition holds", async () => {
      const { app, driver } = driverFor();
      await driver.visit("/counter");
      await driver.until(
        "the counter reaches 3",
        ({ page }) => page.body.includes("Count: 3"),
        { interval: 1 },
      );
      await driver.assertText("Count: 3");
      expect(app.requests).toHaveLength(3);
    });

    it("does not re-send a POST; the predicate is re-evaluated as it is", async () => {
      const { app, driver } = driverFor({
        "/": `<form method="post" action="/echo"><button>Go</button></form>`,
      });
      await driver.visit("/");
      await driver.clickButton("Go");
      let calls = 0;
      await driver.until("the third check", () => ++calls === 3, {
        interval: 1,
      });
      expect(app.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    });

    it("names what it waited for when the budget runs out", async () => {
      const { driver } = driverFor();
      await driver.visit("/counter");
      await expect(
        driver.until(
          "the counter reaches 1000",
          ({ page }) => page.body.includes("Count: 1000"),
          { timeout: 30, interval: 5 },
        ),
      ).rejects.toThrow(
        /^until: the counter reaches 1000 — condition was still not met after 30ms \(\d+ checks, re-fetching GET http:\/\/localhost\/counter between them\)\.$/,
      );
    });
  });

  describe("debug()", () => {
    it("prints the URL, the status and the scope's HTML, with password values hidden", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const { driver } = driverFor({
          "/": `<form><input type="password" name="pw" value="hunter2"><p class="note">Hi</p></form>`,
        });
        await driver.visit("/");
        await driver.debug();
        const printed = log.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(printed).toContain("GET http://localhost/ (200)");
        expect(printed).toContain('<p class="note">Hi</p>');
        expect(printed).toContain('value="••••••"');
        expect(printed).not.toContain("hunter2");
        log.mockClear();
        await (await driver.within(".note")).debug();
        expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
          "within('.note')",
        );
      } finally {
        log.mockRestore();
      }
    });
  });

  describe("assertDownload()", () => {
    it("passes when the trigger gets a Content-Disposition: attachment response, and stays on the page", async () => {
      const { driver } = driverFor({
        "/exports": `<a href="/report.csv">Export</a>`,
      });
      await driver.visit("/exports");
      await driver.assertDownload("report.csv", () =>
        driver.clickLink("Export"),
      );
      await driver.assertDownload(/\.csv$/, () => driver.clickLink("Export"));
      await driver.assertPath("/exports");
      await driver.assertText("Export");
    });

    it("a link's download attribute makes any response a download", async () => {
      const { driver } = driverFor({
        "/exports": `<a href="/api/status" download="status.json">Status</a><a href="/api/status" download>Unnamed</a>`,
      });
      await driver.visit("/exports");
      await driver.assertDownload("status.json", () =>
        driver.clickLink("Status"),
      );
      await driver.assertDownload("status", () => driver.clickLink("Unnamed"));
    });

    it("fails when nothing was downloaded, or the name differs", async () => {
      const { driver } = driverFor({
        "/exports": `<a href="/report.csv">Export</a><a href="/about">About</a>`,
      });
      await driver.visit("/exports");
      await expect(
        driver.assertDownload("x.csv", () => driver.clickLink("About")),
      ).rejects.toThrow(
        "assertDownload('x.csv'): the trigger led to no download (no response with Content-Disposition: attachment, and no <a download>).",
      );
      await driver.visit("/exports");
      await expect(
        driver.assertDownload("x.csv", () => driver.clickLink("Export")),
      ).rejects.toThrow(
        "assertDownload('x.csv'): the browser offered a download named 'report.csv' instead.",
      );
    });
  });

  describe("non-HTML responses", () => {
    it("shows a text or JSON body as a browser would, as preformatted text", async () => {
      const { driver } = driverFor();
      await driver.visit("/api/status");
      await driver.assertText('{"ok":true}');
      await driver.assertHas("pre");
    });
  });

  describe("browser-only verbs", () => {
    const cases: [string, (d: RequestDriver) => Promise<void>][] = [
      ["hover()", (d) => d.hover("Hi")],
      ["dropFile()", (d) => d.dropFile("#zone", NOTES)],
      ["assertComputedStyle()", (d) => d.assertComputedStyle("color", "red")],
      ["assertNoHorizontalOverflow()", (d) => d.assertNoHorizontalOverflow()],
      ["assertHorizontalOverflow()", (d) => d.assertHorizontalOverflow()],
      [
        "assertHorizontallyContained()",
        (d) => d.assertHorizontallyContained("p"),
      ],
      ["scrollToHorizontalEnd()", (d) => d.scrollToHorizontalEnd()],
    ];
    it.each(cases)(
      "%s throws BrowserOnlyVerbError naming the verb and this adapter",
      async (verb, invoke) => {
        const { driver } = driverFor({ "/": `<p id="zone">Hi</p>` });
        await driver.visit("/");
        const error = await invoke(driver).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BrowserOnlyVerbError);
        expect((error as Error).message).toContain(
          `${verb} is a browser-only verb`,
        );
        expect((error as Error).message).toContain(
          "this adapter runs in plain HTTP requests and parsed HTML",
        );
      },
    );
  });
});

describe("createSession() (request adapter)", () => {
  it("drives the PRG flow the same chain drives in a browser", async () => {
    const app = createFixtureApp();
    await createSession(app.handle)
      .visit("/")
      .fillIn("What needs to be done?", "Read the guide on routing")
      .clickButton("Add")
      .assertText("Read the guide on routing")
      .assertPath("/")
      .within("#todo-1", (todo) => todo.clickButton("Done"))
      .assertHas("li.todo.completed", { count: 1 })
      .within(".count", (count) => count.assertExactText("0 items left"));
    expect(
      app.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([
      "GET /",
      "POST /todos",
      "GET /",
      "POST /todos/1/toggle",
      "GET /",
    ]);
  });

  it("renders a server-side validation error page (422) like any other page", async () => {
    const app = createFixtureApp();
    await createSession(app.handle)
      .visit("/")
      .clickButton("Add")
      .assertText("Title can't be blank")
      .assertPath("/todos");
  });

  it("takes a base URL, and a plain fetch-shaped handler", async () => {
    const app = createFixtureApp();
    const fetchLike = (input: Request) => app.handle(input);
    await createSession(fetchLike, { baseUrl: "https://shop.test" })
      .visit("/echo")
      .assertText("GET");
    expect(app.requests[0].url).toBe("https://shop.test/echo");
  });

  it("a failing step is named in the chain trace, with secrets hidden", async () => {
    const app = createFixtureApp();
    const error = await createSession(app.handle)
      .visit("/login")
      .fillIn("Email", "ada@example.com")
      .fillIn("Password", "hunter2")
      .clickButton("Log in")
      .assertText("Dashboard")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(StepError);
    const message = (error as Error).message;
    expect(message).toContain(">>> [FAILED] clickButton('Log in')");
    expect(message).toContain(
      "no button named 'Log in' on GET http://localhost/login (200). Buttons here: 'Sign in'.",
    );
    expect(message).toContain("[ok] fillIn('Password', '••••••')");
    expect(message).not.toContain("hunter2");
  });

  it("assertDownload() and until() work through the session", async () => {
    const app = createFixtureApp({
      "/exports": `<a href="/report.csv">Export</a><a href="/counter">Counter</a>`,
    });
    await createSession(app.handle)
      .visit("/exports")
      .assertDownload("report.csv", (s) => s.clickLink("Export"))
      .clickLink("Counter")
      .until(
        "the counter passes 2",
        ({ page }) => page.body.includes("Count: 3"),
        { interval: 1 },
      )
      .step("read the scope", async ({ scope }) => {
        expect(scope.tagName).toBe("BODY");
      });
  });
});
