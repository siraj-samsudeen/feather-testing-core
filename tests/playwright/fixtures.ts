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

  // Reproduces the real-world collision: a navigation chip whose accessible
  // name merely CONTAINS the name of the control the spec wants. Decoys come
  // first in DOM order so a substring matcher can't land on the right element
  // by luck.
  "/collision": `<!DOCTYPE html>
<html><body>
  <nav class="sidebar">
    <button title="Checklist Run — checklist">Checklist Run — checklist</button>
    <a href="/about">About the checklist</a>
  </nav>
  <main>
    <form>
      <label for="company">Name of company</label>
      <input id="company" name="company" />

      <label for="who">Name</label>
      <input id="who" name="who" />
    </form>
    <button onclick="document.getElementById('msg').textContent='Checked!'">Check</button>
    <a href="/about">About</a>
    <p id="msg"></p>
  </main>
</body></html>`,

  // Work that finishes on its own — the shape until() exists for.
  "/eventual": `<!DOCTYPE html>
<html><body>
  <h1>Eventual</h1>
  <p id="status">Working</p>
  <script>
    setTimeout(function() {
      document.getElementById('status').textContent = 'Ready';
      window.__jobDone = true;
    }, 400);
  </script>
</body></html>`,

  "/reload": `<!DOCTYPE html>
<html><body>
  <main class="panel">
    <p id="load-count"></p>
    <p id="storage"></p>
    <p id="cookie"></p>
  </main>
  <script>
    var count = Number(sessionStorage.getItem('load-count') || '0') + 1;
    sessionStorage.setItem('load-count', String(count));
    document.getElementById('load-count').textContent = 'Loads: ' + count;
    document.getElementById('storage').textContent =
      'Stored: ' + (localStorage.getItem('auth-state') || 'missing');
    document.getElementById('cookie').textContent = 'Cookie: ' + document.cookie;
  </script>
</body></html>`,

  "/keys": `<!DOCTYPE html>
<html><body>
  <label for="cmd">Command</label>
  <input id="cmd" />
  <p id="keys"></p>
  <script>
    var keys = [];
    document.getElementById('cmd').addEventListener('keydown', function(e) {
      keys.push((e.ctrlKey ? 'Control+' : '') + e.key);
      document.getElementById('keys').textContent = 'Keys: ' + keys.join(' ');
    });
  </script>
</body></html>`,

  "/hover": `<!DOCTYPE html>
<html><body>
  <span id="total">Total</span>
  <p id="tooltip"></p>
  <script>
    document.getElementById('total').addEventListener('mouseenter', function() {
      document.getElementById('tooltip').textContent = 'Tooltip: 42 items';
    });
  </script>
</body></html>`,

  "/download": `<!DOCTYPE html>
<html><body>
  <h1>Exports</h1>
  <a id="dl" href="data:text/csv;charset=utf-8,a%2Cb%0A1%2C2" download="report.csv">Export CSV</a>
  <button onclick="document.getElementById('dl').click()">Export</button>
  <button onclick="document.getElementById('nothing')">Do nothing</button>
</body></html>`,

  "/search": `<!DOCTYPE html>
<html><body>
  <h1>Search Results</h1>
  <p>Showing results for your query</p>
</body></html>`,

  "/re/import": `<!DOCTYPE html>
<html><body>
  <h1>Re-Import</h1>
</body></html>`,

  "/import": `<!DOCTYPE html>
<html><body>
  <h1>Import</h1>
</body></html>`,

  "/delayed-field": `<!DOCTYPE html>
<html><body>
  <h1>Delayed Field</h1>
  <div id="slot"></div>
  <script>
    setTimeout(function() {
      document.getElementById('slot').innerHTML =
        '<form><label for="late">Late Field</label><input id="late" name="late" /></form>';
    }, 300);
  </script>
</body></html>`,

  "/submit-precedence": `<!DOCTYPE html>
<html><body>
  <form id="f">
    <label for="val">Value</label>
    <input id="val" name="val" />
    <button type="button" onclick="document.getElementById('r').textContent='Wrong button!'">Submit other</button>
    <button type="submit">Save</button>
  </form>
  <p id="r"></p>
  <script>
    document.getElementById('f').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('r').textContent = 'Saved!';
    });
  </script>
</body></html>`,

  "/upload": `<!DOCTYPE html>
<html><body>
  <form>
    <label for="avatar">Avatar</label>
    <input id="avatar" name="avatar" type="file" />
  </form>
  <div id="dropzone" style="width:200px;height:100px;border:1px dashed #999">Drop files here</div>
  <p id="uploaded"></p>
  <p id="dropped"></p>
  <script>
    document.getElementById('avatar').addEventListener('change', function(e) {
      document.getElementById('uploaded').textContent =
        'Uploaded: ' + e.target.files[0].name + ' (' + e.target.files[0].size + ' bytes)';
    });
    var zone = document.getElementById('dropzone');
    zone.addEventListener('dragover', function(e) { e.preventDefault(); });
    zone.addEventListener('drop', function(e) {
      e.preventDefault();
      var file = e.dataTransfer.files[0];
      document.getElementById('dropped').textContent =
        'Dropped: ' + file.name + ' (' + file.size + ' bytes)';
    });
  </script>
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
