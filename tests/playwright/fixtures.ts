import { test as base } from "@playwright/test";

/**
 * Inline HTML pages served via route interception.
 * No real server needed — page.goto() and page.url() work with real URLs.
 */
export const pages: Record<string, string> = {
  "/": `<!DOCTYPE html>
<html><body>
  <h1>Home</h1>
  <p>Welcome to the home page</p>
  <a href="/about">About</a>
  <a href="/form">Go to form</a>
  <button onclick="document.getElementById('msg').textContent='Clicked!'">Click me</button>
  <p id="msg"></p>
</body></html>`,

  "/about": `<!DOCTYPE html>
<html><body>
  <h1>About</h1>
  <p>About page content</p>
  <a href="/">Home</a>
</body></html>`,

  "/form": `<!DOCTYPE html>
<html><body>
  <h1>Form Page</h1>
  <form id="mainForm">
    <label for="name">Name</label>
    <input id="name" name="name" />

    <input name="nickname" placeholder="Nickname" />

    <label for="email">Email</label>
    <input id="email" name="email" type="email" />

    <label for="color">Favorite Color</label>
    <select id="color" name="color">
      <option value="">--Select--</option>
      <option value="r">Red</option>
      <option value="g">Green</option>
      <option value="b">Blue</option>
    </select>

    <label for="newsletter">Subscribe to newsletter</label>
    <input id="newsletter" name="newsletter" type="checkbox" />

    <label for="ads">Receive ads</label>
    <input id="ads" name="ads" type="checkbox" checked />

    <fieldset>
      <legend>Plan</legend>
      <label><input type="radio" name="plan" value="free" /> Free</label>
      <label><input type="radio" name="plan" value="pro" /> Pro</label>
    </fieldset>

    <button type="submit">Submit</button>
  </form>
  <div id="result"></div>
  <script>
    document.getElementById('mainForm').addEventListener('submit', function(e) {
      e.preventDefault();
      var data = new FormData(e.target);
      var result = [];
      for (var pair of data.entries()) {
        result.push(pair[0] + '=' + pair[1]);
      }
      document.getElementById('result').textContent = 'Submitted: ' + result.join(', ');
    });
  </script>
</body></html>`,

  "/submit-by-name": `<!DOCTYPE html>
<html><body>
  <form id="f">
    <label for="val">Value</label>
    <input id="val" name="val" />
    <button onclick="document.getElementById('r').textContent='Done!'">Submit form</button>
  </form>
  <p id="r"></p>
  <script>
    document.getElementById('f').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('r').textContent = 'Done!';
    });
  </script>
</body></html>`,

  "/submit-by-type": `<!DOCTYPE html>
<html><body>
  <form id="f">
    <label for="val">Value</label>
    <input id="val" name="val" />
    <button type="submit">Go</button>
  </form>
  <p id="r"></p>
  <script>
    document.getElementById('f').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('r').textContent = 'Done!';
    });
  </script>
</body></html>`,

  "/submit-enter": `<!DOCTYPE html>
<html><body>
  <form id="f">
    <label for="val">Value</label>
    <input id="val" name="val" />
    <!-- No submit button -->
  </form>
  <p id="r"></p>
  <script>
    document.getElementById('f').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('r').textContent = 'Done!';
    });
  </script>
</body></html>`,

  "/scoped": `<!DOCTYPE html>
<html><body>
  <div class="sidebar">
    <p>Sidebar content</p>
    <button>Sidebar Button</button>
  </div>
  <div class="main">
    <p>Main content</p>
    <button>Main Button</button>
  </div>
</body></html>`,

  "/multi": `<!DOCTYPE html>
<html><body>
  <ul>
    <li class="item">Apple</li>
    <li class="item">Banana</li>
    <li class="item">Cherry</li>
  </ul>
  <div class="card">Overdue task</div>
  <div class="card">Normal task</div>
  <div class="card special">Important task</div>
  <span class="empty"></span>
</body></html>`,

  "/search": `<!DOCTYPE html>
<html><body>
  <h1>Search Results</h1>
  <p>Showing results for your query</p>
</body></html>`,
};

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route("**/*", async (route, request) => {
      const url = new URL(request.url());
      const html = pages[url.pathname + (url.search || "")];
      const htmlByPath = pages[url.pathname];
      if (html) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: html,
        });
      } else if (htmlByPath) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: htmlByPath,
        });
      } else {
        await route.fulfill({ status: 404, body: "Not Found" });
      }
    });
    await use(context);
  },
});

export { expect } from "@playwright/test";
