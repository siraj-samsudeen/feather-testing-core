/**
 * A tiny server-rendered app built from plain Request/Response handlers, so
 * the request adapter is tested against no framework at all.
 *
 * - `/echo` renders whatever request reached it, so form-submission tests
 *   can assert exactly what a browser would have sent.
 * - `/`, `/todos`, ... are a small TodoMVC-style app using
 *   POST-redirect-GET, the shape the adapter exists for.
 * - `/login`, `/dashboard` use a session cookie.
 * - `pages` adds one-off pages per test.
 */

export type Handler = (request: Request) => Promise<Response>;

export interface FixtureApp {
  handle: Handler;
  /** Every request the app received, in order. */
  requests: Request[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function html(body: string, title = "Fixture"): Response {
  return new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}

async function echo(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const type = request.headers.get("content-type") ?? "";
  const entries: string[] = [];
  for (const [name, value] of url.searchParams) {
    entries.push(`query ${name}=${value}`);
  }
  if (type.startsWith("multipart/form-data")) {
    for (const [name, value] of await request.formData()) {
      if (typeof value === "string") {
        entries.push(`body ${name}=${value}`);
      } else {
        const text = await value.text();
        entries.push(
          `body ${name}=file:${value.name}:${value.type}:${value.size}:${text}`,
        );
      }
    }
  } else if (type.startsWith("application/x-www-form-urlencoded")) {
    for (const [name, value] of new URLSearchParams(await request.text())) {
      entries.push(`body ${name}=${value}`);
    }
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    if (text) entries.push(`raw ${text}`);
  }
  const cookie = request.headers.get("cookie") ?? "";
  return html(
    `<h1>Echo</h1>
     <p id="method">${request.method}</p>
     <p id="path">${escapeHtml(url.pathname)}</p>
     <p id="content-type">${escapeHtml(type.split(";")[0])}</p>
     <p id="cookie">${escapeHtml(cookie)}</p>
     <p id="origin">${escapeHtml(request.headers.get("origin") ?? "")}</p>
     <ul id="entries">${entries.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`,
    "Echo",
  );
}

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

function todoPage(todos: Todo[]): Response {
  const items = todos
    .map(
      (t) => `<li class="todo${t.done ? " completed" : ""}" id="todo-${t.id}">
        <span class="title">${escapeHtml(t.title)}</span>
        <form method="post" action="/todos/${t.id}/toggle"><button>${t.done ? "Undo" : "Done"}</button></form>
        <form method="post" action="/todos/${t.id}/delete"><button>Delete</button></form>
      </li>`,
    )
    .join("");
  return html(
    `<header><h1>todos</h1><a href="/about">About</a></header>
     <form method="post" action="/todos" class="new-todo">
       <input name="title" placeholder="What needs to be done?" autofocus>
       <button>Add</button>
     </form>
     <ul class="todo-list">${items}</ul>
     <footer><span class="count">${todos.filter((t) => !t.done).length} items left</span></footer>`,
    "Todos",
  );
}

export function createFixtureApp(
  pages: Record<
    string,
    string | ((request: Request) => Response | Promise<Response>)
  > = {},
): FixtureApp {
  const requests: Request[] = [];
  const todos: Todo[] = [];
  let nextId = 1;
  let counter = 0;

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    const page = pages[pathname];
    if (page !== undefined) {
      return typeof page === "string" ? html(page) : page(request);
    }

    if (pathname === "/echo" || pathname.startsWith("/echo/")) {
      return echo(request);
    }

    // --- Todo app (POST-redirect-GET) ---
    if (pathname === "/" && method === "GET") return todoPage(todos);
    if (pathname === "/about") {
      return html(`<h1>About</h1><a href="/">Back to todos</a>`, "About");
    }
    if (pathname === "/todos" && method === "POST") {
      const form = new URLSearchParams(await request.text());
      const title = (form.get("title") ?? "").trim();
      if (title === "") {
        return new Response(
          `<!doctype html><html><body><p class="error">Title can't be blank</p></body></html>`,
          { status: 422, headers: { "content-type": "text/html" } },
        );
      }
      todos.push({ id: nextId++, title, done: false });
      return redirect("/");
    }
    const todoAction = pathname.match(/^\/todos\/(\d+)\/(toggle|delete)$/);
    if (todoAction && method === "POST") {
      const id = Number(todoAction[1]);
      const index = todos.findIndex((t) => t.id === id);
      if (index >= 0) {
        if (todoAction[2] === "delete") todos.splice(index, 1);
        else todos[index].done = !todos[index].done;
      }
      return redirect("/");
    }

    // --- Cookie-based login ---
    if (pathname === "/login" && method === "GET") {
      return html(
        `<h1>Sign in</h1>
         <form method="post" action="/login">
           <label for="email">Email</label><input id="email" name="email" type="email">
           <label for="password">Password</label><input id="password" name="password" type="password">
           <button type="submit">Sign in</button>
         </form>`,
        "Sign in",
      );
    }
    if (pathname === "/login" && method === "POST") {
      const form = new URLSearchParams(await request.text());
      const response = redirect("/dashboard", 302);
      response.headers.append(
        "set-cookie",
        `session=${encodeURIComponent(form.get("email") ?? "")}; Path=/; HttpOnly`,
      );
      response.headers.append("set-cookie", "flash=Welcome; Path=/dashboard");
      return response;
    }
    if (pathname === "/logout") {
      const response = redirect("/login");
      response.headers.append("set-cookie", "session=; Path=/; Max-Age=0");
      return response;
    }
    if (pathname === "/dashboard") {
      const cookies = Object.fromEntries(
        (request.headers.get("cookie") ?? "")
          .split(";")
          .filter(Boolean)
          .map((c) => c.trim().split("=") as [string, string]),
      );
      if (!cookies.session) return redirect("/login", 302);
      return html(
        `<h1>Dashboard</h1><p>Signed in as ${escapeHtml(decodeURIComponent(cookies.session))}</p>
         <p class="flash">${escapeHtml(cookies.flash ?? "")}</p>
         <a href="/logout">Sign out</a>`,
        "Dashboard",
      );
    }

    // --- Redirects with every status ---
    const redirectMatch = pathname.match(/^\/redirect\/(\d{3})$/);
    if (redirectMatch) {
      return redirect(`/echo${url.search}`, Number(redirectMatch[1]));
    }
    if (pathname === "/redirect-loop") return redirect("/redirect-loop", 302);

    // --- A page whose content changes on every fetch ---
    if (pathname === "/counter") {
      counter += 1;
      return html(`<p id="count">Count: ${counter}</p>`, "Counter");
    }

    if (pathname === "/report.csv") {
      return new Response("a,b\n1,2\n", {
        headers: {
          "content-type": "text/csv",
          "content-disposition": 'attachment; filename="report.csv"',
        },
      });
    }

    if (pathname === "/api/status") {
      return Response.json({ ok: true });
    }

    return new Response(
      `<!doctype html><html><body><h1>Not found</h1><p>${escapeHtml(pathname)}</p></body></html>`,
      { status: 404, headers: { "content-type": "text/html" } },
    );
  }

  return {
    requests,
    handle: async (request) => {
      requests.push(request.clone());
      return route(request);
    },
  };
}
