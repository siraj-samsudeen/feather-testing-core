/**
 * Submitting a form the way the HTML spec says a browser does: construct the
 * entry list from the form's successful controls, then encode it for the
 * form's method and enctype.
 * https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm
 */
import {
  baseUrl,
  buttonType,
  formOwner,
  inputType,
  isDisabled,
} from "./dom.js";

export interface Submission {
  method: "GET" | "POST";
  url: URL;
  body: BodyInit | null;
  headers: Headers;
}

type Entry = [name: string, value: string | File];

/** Files a test attached to file inputs; the parser cannot hold them. */
export type AttachedFiles = WeakMap<Element, File>;

/**
 * The type a file was attached with. Bun's File constructor rewrites
 * "text/plain" to "text/plain;charset=utf-8", which a browser does not send,
 * so the declared type is kept beside the File and used for the part header.
 */
const declaredTypes = new WeakMap<File, string>();

/** A File for an attached file, remembering the type it was given. */
export function attachedFile(bytes: BlobPart[], name: string, type: string): File {
  const file = new File(bytes, name, { type });
  declaredTypes.set(file, type);
  return file;
}

const LISTED = "button, input, object, select, textarea";

/** The form's listed elements in tree order, including any outside it that
 * point at it with `form="id"`. */
export function formControls(form: HTMLFormElement): Element[] {
  return Array.from(form.ownerDocument.querySelectorAll(LISTED)).filter(
    (el) => formOwner(el) === form,
  );
}

const BUTTON_INPUT_TYPES = new Set(["submit", "reset", "button", "image"]);

/** A `<button>`, or an input that is drawn as one. */
export function isButtonElement(element: Element): boolean {
  if (element.tagName === "BUTTON") return true;
  return (
    element.tagName === "INPUT" && BUTTON_INPUT_TYPES.has(inputType(element))
  );
}

/** A reset button: one that restores its form's defaults when activated. */
export function isResetButton(element: Element): boolean {
  if (element.tagName === "BUTTON") return buttonType(element) === "reset";
  return element.tagName === "INPUT" && inputType(element) === "reset";
}

/** A submit button: one that submits its form when activated. */
export function isSubmitButton(element: Element): boolean {
  if (element.tagName === "BUTTON") return buttonType(element) === "submit";
  if (element.tagName === "INPUT") {
    const type = inputType(element);
    return type === "submit" || type === "image";
  }
  return false;
}

/** Newlines in submitted strings are always CRLF. */
function crlf(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

/** The entry list for a form submitted by `submitter` (null for implicit or
 * scripted submission). */
export function entryList(
  form: HTMLFormElement,
  submitter: Element | null,
  files: AttachedFiles,
): Entry[] {
  const entries: Entry[] = [];
  for (const el of formControls(form)) {
    if (el.closest("datalist") || isDisabled(el)) continue;
    if (isButtonElement(el) && el !== submitter) continue;
    if (el.tagName === "OBJECT") continue;

    const name = el.getAttribute("name") ?? "";
    if (el.tagName === "INPUT" && inputType(el) === "image") {
      const prefix = name === "" ? "" : `${name}.`;
      entries.push([`${prefix}x`, "0"], [`${prefix}y`, "0"]);
      continue;
    }
    if (name === "") continue;

    if (el.tagName === "SELECT") {
      for (const option of Array.from((el as HTMLSelectElement).options)) {
        if (
          option.selected &&
          !isDisabled(option) &&
          !option.parentElement?.matches("optgroup[disabled]")
        ) {
          entries.push([name, option.value]);
        }
      }
      continue;
    }
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      const type = inputType(input);
      if (type === "checkbox" || type === "radio") {
        if (!input.checked) continue;
        entries.push([name, input.getAttribute("value") ?? "on"]);
        continue;
      }
      if (type === "file") {
        entries.push([
          name,
          files.get(input) ??
            new File([], "", { type: "application/octet-stream" }),
        ]);
        continue;
      }
      if (
        type === "hidden" &&
        name.toLowerCase() === "_charset_" &&
        !input.hasAttribute("value")
      ) {
        entries.push([name, "UTF-8"]);
        continue;
      }
    }
    entries.push([name, (el as HTMLInputElement).value]);
    const dirname = el.getAttribute("dirname");
    if (dirname && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      entries.push([dirname, "ltr"]);
    }
  }
  return entries.map(([n, v]) => [
    crlf(n),
    typeof v === "string" ? crlf(v) : v,
  ]);
}

/**
 * Interactive validation, the part of it a test meets most: a browser will
 * not send a form while a `required` control is empty. `pattern`, `min`,
 * `type="email"` and the rest are not checked; the server's own validation
 * is what a request test is for.
 */
export function firstMissingRequired(
  form: HTMLFormElement,
  submitter: Element | null,
  files: AttachedFiles,
): Element | null {
  if (
    form.hasAttribute("novalidate") ||
    submitter?.hasAttribute("formnovalidate")
  ) {
    return null;
  }
  for (const el of formControls(form)) {
    if (
      !el.hasAttribute("required") ||
      isDisabled(el) ||
      el.hasAttribute("readonly")
    )
      continue;
    if (el.tagName === "SELECT") {
      const selected = Array.from((el as HTMLSelectElement).options).filter(
        (o) => o.selected,
      );
      if (selected.length === 0 || selected.every((o) => o.value === ""))
        return el;
      continue;
    }
    if (el.tagName === "TEXTAREA") {
      if ((el as HTMLTextAreaElement).value === "") return el;
      continue;
    }
    if (el.tagName !== "INPUT") continue;
    const input = el as HTMLInputElement;
    const type = inputType(input);
    if (type === "checkbox") {
      if (!input.checked) return el;
    } else if (type === "radio") {
      const group = formControls(form).filter(
        (other) =>
          other.tagName === "INPUT" &&
          inputType(other) === "radio" &&
          other.getAttribute("name") === input.getAttribute("name"),
      );
      if (!group.some((r) => (r as HTMLInputElement).checked)) return el;
    } else if (type === "file") {
      if (!files.has(input)) return el;
    } else if (type !== "hidden" && !BUTTON_INPUT_TYPES.has(type)) {
      if (input.value === "") return el;
    }
  }
  return null;
}

/** The request a browser would send for this form and submitter. */
export function buildSubmission(
  verb: string,
  form: HTMLFormElement,
  submitter: Element | null,
  pageUrl: URL,
  files: AttachedFiles,
): Submission {
  const attr = (formAttr: string, ownAttr: string): string | null =>
    (submitter?.hasAttribute(formAttr)
      ? submitter.getAttribute(formAttr)
      : null) ?? form.getAttribute(ownAttr);

  const methodAttr = (attr("formmethod", "method") ?? "get")
    .trim()
    .toLowerCase();
  if (methodAttr === "dialog") {
    throw new Error(
      `${verb}: this form has method="dialog", which closes a dialog in the browser and sends nothing.`,
    );
  }
  const method = methodAttr === "post" ? "POST" : "GET";

  const action = attr("formaction", "action");
  const url =
    action === null || action.trim() === ""
      ? new URL(pageUrl)
      : new URL(action.trim(), baseUrl(form.ownerDocument, pageUrl));

  const enctypeAttr = (attr("formenctype", "enctype") ?? "")
    .trim()
    .toLowerCase();
  const enctype =
    enctypeAttr === "multipart/form-data" || enctypeAttr === "text/plain"
      ? enctypeAttr
      : "application/x-www-form-urlencoded";

  const entries = entryList(form, submitter, files);
  const headers = new Headers();

  if (method === "GET") {
    url.search = urlencoded(entries);
    return { method, url, body: null, headers };
  }
  if (enctype === "multipart/form-data") {
    const boundary = `----FeatherTestingBoundary${crypto.randomUUID().replaceAll("-", "")}`;
    headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
    return { method, url, body: multipart(entries, boundary), headers };
  }
  if (enctype === "text/plain") {
    headers.set("content-type", "text/plain;charset=UTF-8");
    const body = entries
      .map(
        ([name, value]) =>
          `${name}=${typeof value === "string" ? value : value.name}\r\n`,
      )
      .join("");
    return { method, url, body, headers };
  }
  headers.set("content-type", "application/x-www-form-urlencoded");
  return { method, url, body: urlencoded(entries), headers };
}

/**
 * multipart/form-data, serialized here rather than by the runtime's FormData
 * so every runtime sends the same bytes a browser does — Node's omits
 * `filename=""` for an empty file input, Bun's and browsers' keep it.
 */
function multipart(entries: Entry[], boundary: string): Blob {
  // The spec's escaping for names and filenames in the header.
  const escape = (value: string) =>
    value
      .replaceAll("\n", "%0A")
      .replaceAll("\r", "%0D")
      .replaceAll('"', "%22");
  const parts: BlobPart[] = [];
  for (const [name, value] of entries) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"`,
    );
    if (typeof value === "string") {
      parts.push(`\r\n\r\n${value}\r\n`);
    } else {
      parts.push(
        `; filename="${escape(value.name)}"\r\nContent-Type: ${declaredTypes.get(value) || value.type || "application/octet-stream"}\r\n\r\n`,
        value,
        "\r\n",
      );
    }
  }
  parts.push(`--${boundary}--\r\n`);
  return new Blob(parts);
}

/** application/x-www-form-urlencoded; a file contributes its name. */
function urlencoded(entries: Entry[]): string {
  return new URLSearchParams(
    entries.map(([name, value]) => [
      name,
      typeof value === "string" ? value : value.name,
    ]),
  ).toString();
}
