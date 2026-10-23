/**
 * Reading parsed HTML the way a browser would show it, without CSS or
 * JavaScript: what text is rendered, what a control is called, which
 * controls are disabled.
 */

/** Trim and collapse whitespace runs, the normalization Playwright and
 * Testing Library apply before comparing text. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Elements whose content a browser never renders as page text. */
const NOT_RENDERED = new Set([
  "HEAD",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "TITLE",
]);

/** Whether a browser would render this element at all, judged from markup
 * alone: `hidden`, `<template>`, `<script>`... and the same for an ancestor. */
export function isRendered(element: Element): boolean {
  for (let el: Element | null = element; el; el = el.parentElement) {
    if (NOT_RENDERED.has(el.tagName) || el.hasAttribute("hidden")) {
      return false;
    }
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") {
      return false;
    }
  }
  return true;
}

/**
 * The text a browser would render inside `node`: text nodes outside
 * non-rendered descendants, plus, `withAlt`, the `alt` of images (which is
 * what an accessible name reads for them). Whether `node` itself is
 * rendered is the caller's question.
 */
export function renderedText(node: Node, { withAlt = false } = {}): string {
  let text = "";
  const walk = (current: Node) => {
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 3) {
        text += child.textContent ?? "";
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (NOT_RENDERED.has(el.tagName) || el.hasAttribute("hidden")) continue;
        if (withAlt && el.tagName === "IMG") {
          text += ` ${el.getAttribute("alt") ?? ""} `;
          continue;
        }
        walk(el);
      }
    }
  };
  walk(node);
  return text;
}

/** Text of a label, without the text of controls nested inside it (a
 * wrapping `<label>Plan <select>…</select></label>` is called "Plan"). */
export function labelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  for (const nested of Array.from(
    copy.querySelectorAll(
      "select, textarea, datalist, button, meter, output, progress",
    ),
  )) {
    nested.remove();
  }
  return normalize(renderedText(copy));
}

function textOfIds(element: Element, ids: string): string {
  const document = element.ownerDocument;
  return normalize(
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
      .map((el) => renderedText(el, { withAlt: true }))
      .join(" "),
  );
}

/** Every name a form control answers to: aria-labelledby, aria-label, and
 * each associated `<label>` (by `for`, or by wrapping). */
export function controlLabels(control: Element): string[] {
  const names: string[] = [];
  const labelledBy = control.getAttribute("aria-labelledby");
  if (labelledBy) names.push(textOfIds(control, labelledBy));
  const ariaLabel = control.getAttribute("aria-label");
  if (ariaLabel) names.push(normalize(ariaLabel));
  const labels = (control as HTMLInputElement).labels;
  for (const label of labels ? Array.from(labels) : []) {
    // A wrapping label without `for` labels only its first labelable
    // descendant, whatever else is inside it.
    if (!label.hasAttribute("for") && label.control !== control) continue;
    names.push(labelText(label));
  }
  return names.filter((name) => name !== "");
}

/** How a person would refer to a control in a message: its first label,
 * else its name attribute. */
export function describeControl(control: Element): string {
  return (
    controlLabels(control)[0] ??
    control.getAttribute("name") ??
    control.tagName.toLowerCase()
  );
}

/** The accessible name of a button or link, as far as markup decides it. */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const name = textOfIds(element, labelledBy);
    if (name) return name;
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && normalize(ariaLabel)) return normalize(ariaLabel);
  if (element.tagName === "INPUT") {
    const type = inputType(element);
    const value = element.getAttribute("value");
    if (type === "image") {
      return normalize(element.getAttribute("alt") ?? value ?? "Submit");
    }
    if (value !== null) return normalize(value);
    if (type === "submit") return "Submit";
    if (type === "reset") return "Reset";
    return "";
  }
  const text = normalize(renderedText(element, { withAlt: true }));
  if (text) return text;
  return normalize(element.getAttribute("title") ?? "");
}

/** An input's type as the HTML spec reads it: lowercase, "text" when absent
 * or unknown to us. */
export function inputType(element: Element): string {
  const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
  return INPUT_TYPES.has(type) ? type : "text";
}

const INPUT_TYPES = new Set([
  "hidden",
  "text",
  "search",
  "tel",
  "url",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
  "range",
  "color",
  "checkbox",
  "radio",
  "file",
  "submit",
  "image",
  "reset",
  "button",
]);

/** A button's type: submit unless it says reset or button. */
export function buttonType(element: Element): string {
  const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
  return type === "reset" || type === "button" ? type : "submit";
}

/** Disabled by its own attribute, or by a disabled `<fieldset>` it is not in
 * the first `<legend>` of. */
export function isDisabled(element: Element): boolean {
  if (element.hasAttribute("disabled")) return true;
  for (let el = element.parentElement; el; el = el.parentElement) {
    if (el.tagName === "FIELDSET" && el.hasAttribute("disabled")) {
      const firstLegend = Array.from(el.children).find(
        (c) => c.tagName === "LEGEND",
      );
      if (!firstLegend || !firstLegend.contains(element)) return true;
    }
  }
  return false;
}

/** The form a control belongs to: its `form` attribute's target, else its
 * nearest ancestor form. */
export function formOwner(element: Element): HTMLFormElement | null {
  const id = element.getAttribute("form");
  if (id !== null) {
    const target = element.ownerDocument.getElementById(id);
    return target?.tagName === "FORM" ? (target as HTMLFormElement) : null;
  }
  return element.closest("form");
}

/** The URL relative links and actions resolve against: `<base href>` if the
 * page has one, else the page's own URL. */
export function baseUrl(document: Document, pageUrl: URL): URL {
  const href = document.querySelector("base[href]")?.getAttribute("href");
  return href ? new URL(href, pageUrl) : pageUrl;
}
