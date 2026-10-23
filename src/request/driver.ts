import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type {
  SessionOptions,
  AssertHasOptions,
  AssertPathOptions,
  AssertionOptions,
  DownloadOptions,
  LayoutAssertionOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";
import { BrowserOnlyVerbError } from "../errors.js";
import { DEFAULT_TIMEOUT, withinCountMessage } from "../types.js";
import { HIDDEN_VALUE } from "../secrets.js";
import { RequestBrowser, type RequestHandler } from "./browser.js";
import {
  accessibleName,
  baseUrl,
  controlLabels,
  formOwner,
  inputType,
  isDisabled,
  isRendered,
  normalize,
  renderedText,
} from "./dom.js";
import {
  attachedFile,
  formControls,
  isButtonElement,
  isResetButton,
  isSubmitButton,
} from "./form.js";

export interface RequestDriverOptions extends SessionOptions {
  /**
   * What visit() paths resolve against: an origin, optionally with a base
   * path. Defaults to http://localhost.
   */
  baseUrl?: string;
}

/** The native handle raw() callbacks receive in the request adapter. */
export interface RequestPage {
  /** The parsed current page (a happy-dom document, typed as the DOM's). */
  document: Document;
  /** The response that produced it — a fresh clone, so its body can be read. */
  response: Response;
  /** The current URL, after redirects. */
  url: URL;
  /** The response body as text. */
  body: string;
}

/** Context handed to custom step() and until() callbacks in the request adapter. */
export interface RequestStepContext {
  /** The current page, as raw() receives it. */
  page: RequestPage;
  /** Current scope: `<body>`, or the within() element. */
  scope: Element;
  /**
   * Send a request with the session's cookies without navigating, as the
   * page's own script would; relative URLs resolve against the current page.
   * Set-Cookie on the response is kept.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** until()'s cadence when the caller sets none, in ms. Its budget is the
 * session `timeout` (default DEFAULT_TIMEOUT), as in the Playwright adapter. */
const DEFAULT_UNTIL_INTERVAL = 100;

/** Where BrowserOnlyVerbError says this adapter runs. */
const ENVIRONMENT = "plain HTTP requests and parsed HTML";

/** Controls a label can name (hidden inputs drop out as not rendered). */
const LABELABLE = "input, select, textarea, button, meter, output, progress";

const LINKS = "a[href], area[href]";
const BUTTONS = "button, input, [role=button]";

/** Input types fillIn() cannot type into. */
const NOT_TYPEABLE = new Set([
  "checkbox",
  "radio",
  "file",
  "submit",
  "reset",
  "button",
  "image",
  "hidden",
]);

/** Fields that stop Enter from submitting a form with no submit button. */
const BLOCKS_IMPLICIT_SUBMISSION = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);

/**
 * Request adapter: drives a server-rendered app through its request handler,
 * with no browser — the equivalent of Phoenix Test's static driver. Links are
 * followed and forms submitted the way a browser does without JavaScript,
 * redirects are followed, cookies kept, and each response is parsed with
 * happy-dom.
 *
 * Responses arrive complete, so nothing waits: every verb looks at the
 * current page once, and the `timeout` options the interface allows are
 * accepted and ignored. until() is the exception, see there.
 *
 * As in the RTL adapter, everything a host adapter is likely to specialize
 * is `protected`: the label-to-control lookup (`findField`), the
 * scoped-driver factory (`scoped`), and the state the verbs share.
 */
export class RequestDriver
  implements TestDriver<RequestStepContext, RequestPage>
{
  /** The tab: current page, cookies, attached files, downloads. Shared by
   * every driver within() makes from this one. */
  protected browser: RequestBrowser;
  /**
   * The within() chain this driver is scoped to, outermost first. Kept as
   * selectors rather than elements because a navigation replaces the whole
   * document: like a Playwright locator, the scope is re-resolved against
   * whatever page is current when each step runs.
   */
  protected scopeSelectors: readonly string[];
  /** The form the most recent form verb touched; submit() submits it. */
  protected lastForm: HTMLFormElement | null = null;
  /** The field the most recent fillIn() found; null if it found none. */
  protected lastFilledField: Element | null = null;

  /**
   * `handler` is anything that answers a Request: `app.handle` (Elysia),
   * `app.fetch` (Hono), `fetch` itself. Scoped drivers pass the shared
   * RequestBrowser instead.
   */
  /** The session options; within() hands them to the scoped driver. */
  protected options: RequestDriverOptions;

  constructor(
    handler: RequestHandler | RequestBrowser,
    options: RequestDriverOptions = {},
    scopeSelectors: readonly string[] = [],
  ) {
    this.options = options;
    this.browser =
      handler instanceof RequestBrowser
        ? handler
        : new RequestBrowser(
            handler,
            new URL(options.baseUrl ?? "http://localhost"),
          );
    this.scopeSelectors = scopeSelectors;
  }

  // --- Scope ---

  /** The element the current scope stands for: body when unscoped. */
  protected scopeElement(): HTMLElement {
    return this.resolveScope() ?? this.browser.current.document.body;
  }

  /** What selectors resolve against: the scope element, or the whole
   * document when unscoped (so `within("html")` works, as in Playwright). */
  protected queryRoot(): ParentNode {
    return this.resolveScope() ?? this.browser.current.document;
  }

  /** A within() chain resolved against the current page; null unscoped. */
  private resolveScope(
    selectors: readonly string[] = this.scopeSelectors,
  ): HTMLElement | null {
    let root: ParentNode = this.browser.current.document;
    let scope: HTMLElement | null = null;
    const path: string[] = [];
    for (const selector of selectors) {
      path.push(selector);
      const matches = root.querySelectorAll<HTMLElement>(selector);
      if (matches.length !== 1) {
        throw new Error(
          withinCountMessage(path.join("' > '"), matches.length, this.browser.describe()),
        );
      }
      scope = matches[0];
      root = scope;
    }
    return scope;
  }

  /** The scope's text as rendered, whitespace-normalized. */
  protected scopeText(): string {
    const scope = this.scopeElement();
    return isRendered(scope) ? normalize(renderedText(scope)) : "";
  }

  /** Subclasses override this so within() yields a driver of their own type. */
  protected scoped(
    selectors: readonly string[],
  ): TestDriver<RequestStepContext, RequestPage> {
    return new RequestDriver(this.browser, this.options, selectors);
  }

  // --- Navigation ---

  async visit(path: string): Promise<void> {
    await this.browser.navigate(
      `visit('${path}')`,
      new URL(path, this.browser.baseUrl),
    );
  }

  /** Send the request that produced the current page again — a POST too,
   * as a browser's reload resubmits. */
  async reload(): Promise<void> {
    await this.browser.reload();
  }

  // --- Finding controls ---

  /**
   * The single label-addressed lookup: every labelled verb goes through it,
   * so overriding this one method retargets them all.
   *
   * Addresses controls the way the other adapters do — exactly
   * (whitespace-normalized, case-sensitive): first by label (`<label for>`,
   * a wrapping `<label>`, `aria-labelledby`, `aria-label`), then by
   * placeholder. More than one match is an error, like Playwright's strict
   * mode: scope the lookup with within() instead.
   */
  protected findField(label: string, verb: string): Element {
    const root = this.queryRoot();
    const wanted = normalize(label);
    const controls = Array.from(root.querySelectorAll(LABELABLE)).filter(
      isRendered,
    );
    let matches = controls.filter((c) => controlLabels(c).includes(wanted));
    if (matches.length === 0) {
      matches = Array.from(
        root.querySelectorAll("input[placeholder], textarea[placeholder]"),
      ).filter(
        (c) =>
          isRendered(c) &&
          normalize(c.getAttribute("placeholder") ?? "") === wanted,
      );
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `${verb}: ${matches.length} fields are labelled '${label}' on ` +
          `${this.browser.describe()}. Scope the step with within(selector, ...) to pick one.`,
      );
    }
    const known = controls
      .map((c) => controlLabels(c)[0] ?? c.getAttribute("placeholder"))
      .filter((name): name is string => Boolean(name));
    throw new Error(
      `${verb}: no field labelled '${label}' (or with that placeholder) on ` +
        `${this.browser.describe()}. ` +
        (known.length
          ? `Fields here: ${quoteList(known)}.`
          : "No labelled fields here."),
    );
  }

  /** findField(), and the field must be what `accepts` says (`kind`). */
  private fieldOf(
    label: string,
    verb: string,
    kind: string,
    accepts: (el: Element) => boolean,
  ): Element {
    const field = this.findField(label, verb);
    if (!accepts(field)) {
      throw new Error(
        `${verb}: the field labelled '${label}' is ${describeTag(field)}, not ${kind}.`,
      );
    }
    return field;
  }

  private checkbox(
    label: string,
    verb: string,
    allowRadio = false,
  ): HTMLInputElement {
    return this.fieldOf(
      label,
      verb,
      allowRadio ? "a checkbox or radio button" : "a checkbox",
      (el) => isInput(el, "checkbox") || (allowRadio && isInput(el, "radio")),
    ) as HTMLInputElement;
  }

  private radio(label: string, verb: string): HTMLInputElement {
    return this.fieldOf(label, verb, "a radio button", (el) =>
      isInput(el, "radio"),
    ) as HTMLInputElement;
  }

  private select(label: string, verb: string): HTMLSelectElement {
    return this.fieldOf(
      label,
      verb,
      "a <select>",
      (el) => el.tagName === "SELECT",
    ) as HTMLSelectElement;
  }

  /** The one element in scope of `selector` whose accessible name is
   * exactly `text`; `what` names the kind in errors. */
  private named(
    selector: string,
    text: string,
    verb: string,
    what: string,
    keep: (el: Element) => boolean = () => true,
  ): Element {
    const wanted = normalize(text);
    const all = Array.from(this.queryRoot().querySelectorAll(selector)).filter(
      (el) =>
        keep(el) && isRendered(el) && el.getAttribute("aria-hidden") !== "true",
    );
    const matches = all.filter((el) => accessibleName(el) === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `${verb}: ${matches.length} ${what}s are named '${text}' on ` +
          `${this.browser.describe()}. Scope the step with within(selector, ...) to pick one.`,
      );
    }
    const names = [...new Set(all.map(accessibleName).filter(Boolean))];
    const kind = `${what[0].toUpperCase()}${what.slice(1)}s`;
    throw new Error(
      `${verb}: no ${what} named '${text}' on ${this.browser.describe()}. ` +
        (names.length
          ? `${kind} here: ${quoteList(names)}.`
          : `There are no ${what}s here.`),
    );
  }

  /** The innermost element in scope whose rendered text is exactly `text`
   * (a button-like input counts by its value). */
  private byExactText(text: string, verb: string): Element {
    const wanted = normalize(text);
    const scope = this.scopeElement();
    const candidates = [scope, ...Array.from(scope.querySelectorAll("*"))]
      .filter(isRendered)
      .filter((el) =>
        el.tagName === "INPUT"
          ? isButtonElement(el) && accessibleName(el) === wanted
          : normalize(renderedText(el)) === wanted,
      );
    const innermost = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other)),
    );
    if (innermost.length === 1) return innermost[0];
    if (innermost.length > 1) {
      throw new Error(
        `${verb}: ${innermost.length} elements have the text '${text}' on ` +
          `${this.browser.describe()}. Scope the step with within(selector, ...) to pick one.`,
      );
    }
    throw new Error(
      `${verb}: no element with the text '${text}' on ${this.browser.describe()}.`,
    );
  }

  private requireEnabled(control: Element, verb: string, what = "field"): void {
    if (isDisabled(control)) {
      throw new Error(`${verb}: the ${what} is disabled.`);
    }
  }

  /** Remember the control a verb acted on: it has focus, and its form is
   * what submit() submits. */
  private touched(control: Element): void {
    this.browser.focused = control;
    this.lastForm = formOwner(control);
  }

  // --- Interactions ---

  /**
   * Click whatever element has exactly this text, and do what a click on it
   * does without JavaScript: follow its link, press its button, or activate
   * the control of its label.
   */
  async click(text: string): Promise<void> {
    const verb = `click('${text}')`;
    const target = this.byExactText(text, verb);
    const actionable = target.closest(`${LINKS}, ${BUTTONS}, label`);
    if (actionable?.matches(LINKS)) {
      await this.follow(actionable, verb);
      return;
    }
    const control =
      actionable?.tagName === "LABEL"
        ? (actionable as HTMLLabelElement).control
        : actionable;
    if (!control) {
      throw new BrowserOnlyVerbError(
        verb,
        "The element is not a link, a button, or a label of a control, so " +
          "clicking it can only do something through JavaScript. Test that in a Playwright spec.",
        ENVIRONMENT,
      );
    }
    if (isButtonElement(control) || control.matches("[role=button]")) {
      await this.press(control, verb);
    } else {
      this.activate(control, verb);
    }
  }

  async clickLink(text: string): Promise<void> {
    const verb = `clickLink('${text}')`;
    await this.follow(this.named(LINKS, text, verb, "link"), verb);
  }

  async clickButton(text: string): Promise<void> {
    const verb = `clickButton('${text}')`;
    const button = this.named(
      BUTTONS,
      text,
      verb,
      "button",
      (el) => isButtonElement(el) || el.matches("[role=button]"),
    );
    await this.press(button, verb);
  }

  /** Follow a link: a GET of its href, resolved against the page. */
  protected async follow(link: Element, verb: string): Promise<void> {
    this.browser.focused = link;
    const { document, url } = this.browser.current;
    const href = (link.getAttribute("href") ?? "").trim();
    const target = new URL(href, baseUrl(document, url));
    if (target.protocol === "javascript:") {
      throw new BrowserOnlyVerbError(
        verb,
        "The link's href is a javascript: URL, which only a browser runs. Test it in a Playwright spec.",
        ENVIRONMENT,
      );
    }
    await this.browser.followLink(verb, target, {
      download: link.getAttribute("download") ?? undefined,
      hasFragment: href.includes("#"),
    });
  }

  /** Activate a button the way a browser does without JavaScript: submit or
   * reset its form, or follow it when it is a link styled as a button
   * (`<a role="button" href>`). Anything else it could do is script. */
  protected async press(button: Element, verb: string): Promise<void> {
    if (button.matches(LINKS)) {
      await this.follow(button, verb);
      return;
    }
    this.requireEnabled(button, verb, "button");
    this.browser.focused = button;
    const form = isButtonElement(button) ? formOwner(button) : null;
    if (form && isSubmitButton(button)) {
      await this.browser.submit(verb, form, button);
      return;
    }
    if (form && isResetButton(button)) {
      this.resetForm(form);
      return;
    }
    throw new BrowserOnlyVerbError(
      verb,
      "Without JavaScript this button does nothing: it is not a submit or " +
        'reset button of a form (type="button", a role="button" element that is not a link, ' +
        "or outside any <form>). " +
        "Test what its script does in a Playwright spec.",
      ENVIRONMENT,
    );
  }

  /** What clicking a form control does: toggle a checkbox, pick a radio,
   * otherwise just focus it. */
  private activate(control: Element, verb: string): void {
    this.requireEnabled(control, verb);
    if (isInput(control, "checkbox")) {
      (control as HTMLInputElement).checked = !(control as HTMLInputElement)
        .checked;
    } else if (isInput(control, "radio")) {
      (control as HTMLInputElement).checked = true;
    } else if (isInput(control, "file")) {
      throw new BrowserOnlyVerbError(
        verb,
        "Clicking a file input opens the browser's file picker. Use attachFile(label, path) instead.",
        ENVIRONMENT,
      );
    }
    this.touched(control);
  }

  /** What a reset button does: every control back to its default. */
  private resetForm(form: HTMLFormElement): void {
    for (const el of formControls(form)) {
      if (el.tagName === "INPUT") {
        const input = el as HTMLInputElement;
        input.value = input.getAttribute("value") ?? "";
        input.checked = input.hasAttribute("checked");
        this.browser.files.delete(input);
      } else if (el.tagName === "TEXTAREA") {
        (el as HTMLTextAreaElement).value = el.textContent ?? "";
      } else if (el.tagName === "SELECT") {
        const select = el as HTMLSelectElement;
        const options = Array.from(select.options);
        for (const o of options) o.selected = o.hasAttribute("selected");
        if (!select.multiple && !options.some((o) => o.selected)) {
          if (options[0]) options[0].selected = true;
        }
      }
    }
  }

  async fillIn(label: string, value: string): Promise<void> {
    const verb = `fillIn('${label}')`;
    this.lastFilledField = null;
    const field = this.findField(label, verb);
    this.lastFilledField = field;
    const typeable =
      field.tagName === "TEXTAREA" ||
      (field.tagName === "INPUT" && !NOT_TYPEABLE.has(inputType(field)));
    if (!typeable) {
      throw new Error(
        `${verb}: the field labelled '${label}' is ${describeTag(field)}, which cannot be typed into.`,
      );
    }
    this.requireEnabled(field, verb);
    if (field.hasAttribute("readonly")) {
      throw new Error(`${verb}: the field is read-only.`);
    }
    const input = field as HTMLInputElement;
    input.value = value;
    this.touched(field);
    // A number, date or color input drops a value it cannot hold, which
    // would then be sent empty. Playwright's fill() refuses such a value;
    // so does this. (A textarea's value holds newlines as LF.)
    const expected =
      field.tagName === "TEXTAREA" ? value.replace(/\r\n?/g, "\n") : value;
    if (input.value !== expected) {
      throw new Error(
        `${verb}: ${describeTag(field)} cannot hold '${value}' (it would hold '${input.value}').`,
      );
    }
  }

  /**
   * Asked before fillIn's step starts, so the value is hidden from step
   * names and onStep events from the first one. The page is already parsed,
   * so the field is looked up once, as fillIn() will look it up; a field
   * that is missing or ambiguous throws the same error fillIn() would.
   */
  async fieldIsPassword(label: string): Promise<boolean> {
    return isInput(this.findField(label, `fillIn('${label}')`), "password");
  }

  async lastFilledFieldIsPassword(): Promise<boolean> {
    return (
      this.lastFilledField !== null && isInput(this.lastFilledField, "password")
    );
  }

  async selectOption(label: string, option: string): Promise<void> {
    const verb = `selectOption('${label}', '${option}')`;
    const select = this.select(label, verb);
    this.requireEnabled(select, verb);
    const options = Array.from(select.options);
    const chosen = options.find((o) => optionLabel(o) === normalize(option));
    if (!chosen) {
      throw new Error(
        `${verb}: no <option> labelled '${option}'. Options: ${quoteList(options.map(optionLabel))}.`,
      );
    }
    if (isDisabled(chosen) || chosen.closest("optgroup[disabled]")) {
      throw new Error(`${verb}: the option is disabled.`);
    }
    // Like Playwright's selectOption, the choice replaces any selection.
    for (const o of options) o.selected = o === chosen;
    this.touched(select);
  }

  async check(label: string): Promise<void> {
    const verb = `check('${label}')`;
    // Playwright's check() also accepts a radio button; so does this.
    const box = this.checkbox(label, verb, true);
    this.requireEnabled(box, verb);
    box.checked = true;
    this.touched(box);
  }

  async uncheck(label: string): Promise<void> {
    const verb = `uncheck('${label}')`;
    const box = this.checkbox(label, verb);
    this.requireEnabled(box, verb);
    box.checked = false;
    this.touched(box);
  }

  async choose(label: string): Promise<void> {
    const verb = `choose('${label}')`;
    const radio = this.radio(label, verb);
    this.requireEnabled(radio, verb);
    radio.checked = true;
    this.touched(radio);
  }

  /** Submit the form the latest form verb touched, finding its submit
   * control the same way the Playwright adapter does. */
  async submit(): Promise<void> {
    const verb = "submit()";
    const form = this.lastForm;
    if (!form) {
      throw new Error(
        "submit() called but no form was previously interacted with. " +
          "Use fillIn(), selectOption(), check(), uncheck(), or choose() first.",
      );
    }
    if (!this.browser.current.document.contains(form)) {
      throw new Error(
        `${verb}: the form last interacted with is not on the current page any more.`,
      );
    }
    // An explicit type="submit" control, then a button named like
    // "submit", then what pressing Enter does.
    const controls = formControls(form);
    const button =
      controls.find((el) =>
        el.matches('button[type="submit"], input[type="submit"]'),
      ) ??
      controls.find(
        (el) => isButtonElement(el) && /submit/i.test(accessibleName(el)),
      );
    if (button) {
      await this.press(button, verb);
    } else {
      await this.submitImplicitly(form, verb);
    }
  }

  /**
   * What pressing Enter in a field does: click the form's default button
   * (its first submit button), or with none, submit the form if it has at
   * most one text field.
   * https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission
   */
  protected async submitImplicitly(
    form: HTMLFormElement,
    verb: string,
  ): Promise<void> {
    const controls = formControls(form);
    const defaultButton = controls.find(isSubmitButton);
    if (defaultButton) {
      if (isDisabled(defaultButton)) {
        throw new Error(
          `${verb}: the form's default button is disabled, so a browser would not submit it.`,
        );
      }
      await this.press(defaultButton, verb);
      return;
    }
    const textFields = controls.filter(
      (el) =>
        el.tagName === "INPUT" && BLOCKS_IMPLICIT_SUBMISSION.has(inputType(el)),
    );
    if (textFields.length > 1) {
      throw new Error(
        `${verb}: a browser would not submit this form: it has no submit button and more than one text field.`,
      );
    }
    await this.browser.submit(verb, form, null);
  }

  /** Reads the file from disk; the form sends its bytes, name, and a type
   * guessed from the extension, as a browser's file picker would. */
  async attachFile(label: string, path: string): Promise<void> {
    const verb = `attachFile('${label}')`;
    const input = this.fieldOf(label, verb, "a file input", (el) =>
      isInput(el, "file"),
    );
    this.requireEnabled(input, verb);
    const bytes = await readFile(path);
    this.browser.files.set(
      input,
      attachedFile([bytes], basename(path), mimeType(path)),
    );
    this.touched(input);
  }

  /** @deprecated Older name for {@link RequestDriver.attachFile}. */
  async upload(label: string, path: string): Promise<void> {
    await this.attachFile(label, path);
  }

  async dropFile(_selector: string, _path: string): Promise<void> {
    throw new BrowserOnlyVerbError(
      "dropFile()",
      "A drop zone is JavaScript. Use attachFile(label, path) on its file input, " +
        "or test the drop in a Playwright spec.",
      ENVIRONMENT,
    );
  }

  /**
   * Only Enter does anything without JavaScript: in a field it submits the
   * form implicitly, in a textarea it types a newline, on a link or button it
   * activates it. Any other key is browser-only.
   */
  async pressKey(key: string): Promise<void> {
    const verb = `pressKey('${key}')`;
    if (key !== "Enter") {
      throw new BrowserOnlyVerbError(
        verb,
        "Without JavaScript only Enter does anything (it submits the focused field's form). " +
          "Type text with fillIn(), or test key handling in a Playwright spec.",
        ENVIRONMENT,
      );
    }
    const focused = this.browser.focused;
    if (!focused || !this.browser.current.document.contains(focused)) {
      throw new Error(`${verb}: nothing has focus. Fill in a field first.`);
    }
    if (focused.tagName === "TEXTAREA") {
      (focused as HTMLTextAreaElement).value += "\n";
    } else if (focused.matches(LINKS)) {
      await this.follow(focused, verb);
    } else if (isButtonElement(focused)) {
      await this.press(focused, verb);
    } else if (focused.tagName === "INPUT" && formOwner(focused)) {
      await this.submitImplicitly(formOwner(focused)!, verb);
    } else {
      throw new BrowserOnlyVerbError(
        verb,
        "The focused control is not a field of a form, so Enter only does " +
          "something through JavaScript. Test it in a Playwright spec.",
        ENVIRONMENT,
      );
    }
  }

  async hover(_text: string): Promise<void> {
    throw new BrowserOnlyVerbError(
      "hover()",
      "Hovering only changes a page through CSS or JavaScript. Test hover behaviour in a Playwright spec.",
      ENVIRONMENT,
    );
  }

  // --- Assertions ---

  /** Substring, case-insensitive and whitespace-normalized, like Playwright's
   * getByText: an assertion asks "does this text appear". */
  private textAppears(text: string): boolean {
    return this.scopeText()
      .toLowerCase()
      .includes(normalize(text).toLowerCase());
  }

  async assertText(text: string): Promise<void> {
    if (!this.textAppears(text)) {
      const where = this.scopeSelectors.length ? "scope" : "page";
      throw new Error(
        `assertText('${text}'): no text matching '${text}' on ${this.browser.describe()}. ` +
          `The ${where} reads: ${preview(this.scopeText())}`,
      );
    }
  }

  async refuteText(text: string): Promise<void> {
    if (this.textAppears(text)) {
      throw new Error(
        `refuteText('${text}'): expected no text matching '${text}', but found it on ${this.browser.describe()}.`,
      );
    }
  }

  async assertExactText(text: string, _opts?: AssertionOptions): Promise<void> {
    const expected = normalize(text);
    const actual = this.scopeText();
    if (actual !== expected) {
      throw new Error(
        `assertExactText('${text}'): expected normalized text '${expected}', but found '${actual}'.`,
      );
    }
  }

  /** Elements matching `selector` in scope, filtered like the Playwright
   * adapter's hasText: a RegExp by default, a case-insensitive substring
   * with `exact`. */
  private matching(selector: string, opts?: AssertHasOptions): Element[] {
    const all = Array.from(this.queryRoot().querySelectorAll(selector));
    const text = opts?.text;
    if (!text) return all;
    const pattern = opts.exact ? null : new RegExp(text);
    return all.filter((el) => {
      const content = normalize(renderedText(el));
      return pattern
        ? pattern.test(content)
        : content.toLowerCase().includes(text.toLowerCase());
    });
  }

  async assertHas(selector: string, opts?: AssertHasOptions): Promise<void> {
    const verb = `assertHas('${selector}')`;
    const matches = this.matching(selector, opts);
    const withText = opts?.text ? ` with text '${opts.text}'` : "";
    if (opts?.count !== undefined) {
      // Like toHaveCount, the count includes elements that are not rendered.
      if (matches.length !== opts.count) {
        throw new Error(
          `${verb}: expected ${opts.count} elements matching '${selector}'${withText}, ` +
            `but found ${matches.length}.`,
        );
      }
      return;
    }
    if (!matches.some(isRendered)) {
      throw new Error(
        `${verb}: no rendered element matches '${selector}'${withText} on ${this.browser.describe()}.`,
      );
    }
  }

  async refuteHas(selector: string, opts?: AssertHasOptions): Promise<void> {
    const matches = this.matching(selector, opts);
    if (matches.length > 0) {
      const withText = opts?.text ? ` with text '${opts.text}'` : "";
      throw new Error(
        `refuteHas('${selector}'): expected no element matching '${selector}'${withText}, ` +
          `but found ${matches.length}.`,
      );
    }
  }

  async assertAttribute(
    name: string,
    value?: string,
    _opts?: AssertionOptions,
  ): Promise<void> {
    const actual = this.scopeElement().getAttribute(name);
    if (value === undefined ? actual === null : actual !== value) {
      const expected =
        value === undefined ? "to be present" : `to equal '${value}'`;
      const found = actual === null ? "<missing>" : `'${actual}'`;
      throw new Error(
        `assertAttribute('${name}'): expected attribute '${name}' ${expected}, but found ${found}.`,
      );
    }
  }

  async refuteAttribute(name: string, _opts?: AssertionOptions): Promise<void> {
    const actual = this.scopeElement().getAttribute(name);
    if (actual !== null) {
      throw new Error(
        `refuteAttribute('${name}'): expected attribute '${name}' to be absent, but found '${actual}'.`,
      );
    }
  }

  async assertComputedStyle(
    _property: string,
    _value: string,
    _opts?: AssertionOptions,
  ): Promise<void> {
    throw new BrowserOnlyVerbError(
      "assertComputedStyle()",
      "No stylesheets are applied here. Run this assertion in a Playwright spec, " +
        "or assert the class or attribute that selects the style.",
      ENVIRONMENT,
    );
  }

  private browserOnlyLayout(verb: string): never {
    throw new BrowserOnlyVerbError(
      `${verb}()`,
      "Nothing is laid out here. Run this layout operation in a Playwright spec.",
      ENVIRONMENT,
    );
  }

  async assertNoHorizontalOverflow(
    _opts?: LayoutAssertionOptions,
  ): Promise<void> {
    this.browserOnlyLayout("assertNoHorizontalOverflow");
  }

  async assertHorizontalOverflow(
    _opts?: LayoutAssertionOptions,
  ): Promise<void> {
    this.browserOnlyLayout("assertHorizontalOverflow");
  }

  async assertHorizontallyContained(
    _selector: string,
    _opts?: LayoutAssertionOptions,
  ): Promise<void> {
    this.browserOnlyLayout("assertHorizontallyContained");
  }

  async scrollToHorizontalEnd(_opts?: LayoutAssertionOptions): Promise<void> {
    this.browserOnlyLayout("scrollToHorizontalEnd");
  }

  async assertValue(label: string, value: string): Promise<void> {
    const verb = `assertValue('${label}', '${value}')`;
    const actual = (this.findField(label, verb) as HTMLInputElement).value;
    if (actual !== value) {
      throw new Error(
        `${verb}: expected value '${value}', but found '${actual}'.`,
      );
    }
  }

  async assertChecked(label: string): Promise<void> {
    const verb = `assertChecked('${label}')`;
    if (!this.checkbox(label, verb, true).checked) {
      throw new Error(
        `${verb}: expected checkbox to be checked, but it was not.`,
      );
    }
  }

  async refuteChecked(label: string): Promise<void> {
    const verb = `refuteChecked('${label}')`;
    if (this.checkbox(label, verb, true).checked) {
      throw new Error(
        `${verb}: expected checkbox NOT to be checked, but it was.`,
      );
    }
  }

  async assertSelected(label: string, optionText: string): Promise<void> {
    const verb = `assertSelected('${label}', '${optionText}')`;
    const selected = Array.from(this.select(label, verb).options)
      .filter((o) => o.selected)
      .map(optionLabel);
    if (selected.length !== 1 || selected[0] !== normalize(optionText)) {
      throw new Error(
        `${verb}: expected selected option '${optionText}', but found ` +
          `${selected.length ? quoteList(selected) : "'(none)'"}.`,
      );
    }
  }

  async assertOptions(label: string, optionLabels: string[]): Promise<void> {
    const verb = `assertOptions('${label}')`;
    const actual = Array.from(this.select(label, verb).options).map(
      optionLabel,
    );
    const expected = optionLabels.map(normalize);
    const matches =
      actual.length === expected.length &&
      actual.every((text, i) => text === expected[i]);
    if (!matches) {
      throw new Error(
        `${verb}: expected options [${optionLabels.join(", ")}], but found [${actual.join(", ")}].`,
      );
    }
  }

  async assertPath(path: string, opts?: AssertPathOptions): Promise<void> {
    const { url } = this.browser.current;
    const query = opts?.queryParams
      ? `?${new URLSearchParams(opts.queryParams).toString()}`
      : null;
    if (url.pathname !== path || (query !== null && url.search !== query)) {
      throw new Error(
        `assertPath('${path}'): expected path '${path}${query ?? ""}', but the current URL is ${url.href}`,
      );
    }
  }

  async refutePath(path: string): Promise<void> {
    const { url } = this.browser.current;
    if (url.pathname === path) {
      throw new Error(
        `refutePath('${path}'): expected not to be on '${path}', but the current URL is ${url.href}`,
      );
    }
  }

  /**
   * A download is a response with `Content-Disposition: attachment`, or any
   * response to an `<a download>` link; the browser saves it and stays on
   * its page. The name is the one a browser would suggest.
   */
  async assertDownload(
    expected: string | RegExp,
    trigger: () => Promise<void>,
    _opts?: DownloadOptions,
  ): Promise<void> {
    const shown =
      typeof expected === "string" ? `'${expected}'` : String(expected);
    const before = this.browser.downloads.length;
    await trigger();
    const download = this.browser.downloads.slice(before).pop();
    if (!download) {
      throw new Error(
        `assertDownload(${shown}): the trigger led to no download ` +
          "(no response with Content-Disposition: attachment, and no <a download>).",
      );
    }
    const filename = download.suggestedFilename;
    const matched =
      typeof expected === "string"
        ? filename === expected
        : expected.test(filename);
    if (!matched) {
      throw new Error(
        `assertDownload(${shown}): the browser offered a download named '${filename}' instead.`,
      );
    }
  }

  // --- Waiting ---

  /**
   * Responses are complete when they arrive, so nothing here needs waiting
   * for — but the server's state can change. Between checks, a page that
   * came from a GET is fetched again (as a person polling would reload it);
   * a page that came from any other method is not re-sent, and the
   * predicate is simply evaluated again (it may fetch for itself).
   */
  async until(
    description: string,
    predicate: UntilPredicate<RequestStepContext>,
    opts?: UntilOptions,
  ): Promise<void> {
    const timeout = opts?.timeout ?? this.options.timeout ?? DEFAULT_TIMEOUT;
    const interval = opts?.interval ?? DEFAULT_UNTIL_INTERVAL;
    // 0 means no limit, as in Playwright.
    const deadline = timeout === 0 ? Infinity : Date.now() + timeout;
    let checks = 0;
    for (;;) {
      checks++;
      if (await predicate(this.context())) return;
      if (Date.now() + interval > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (this.browser.current.request.method === "GET") {
        await this.browser.reload();
      }
    }
    const { request, url } = this.browser.current;
    const how =
      request.method === "GET"
        ? `re-fetching GET ${url.href} between them`
        : `the page came from a ${request.method}, so it was not re-sent`;
    throw new Error(
      `until: ${description} — condition was still not met after ${timeout}ms (${checks} checks, ${how}).`,
    );
  }

  // --- Escape hatches ---

  async step(
    fn: (context: RequestStepContext) => Promise<unknown>,
  ): Promise<void> {
    await fn(this.context());
  }

  /** raw() hands over the current page itself, not the within() scope. */
  async raw(
    fn: (page: RequestPage) => unknown | Promise<unknown>,
  ): Promise<void> {
    await fn(this.page());
  }

  /** The native handle raw() hands over. */
  protected page(): RequestPage {
    const { document, response, url, body } = this.browser.current;
    return { document, response: response.clone(), url: new URL(url), body };
  }

  /** The adapter context handed to step(), until(), and friends. */
  protected context(): RequestStepContext {
    return {
      page: this.page(),
      scope: this.scopeElement(),
      fetch: (input, init) => this.browser.fetch(input, init),
    };
  }

  // --- Lifecycle ---

  /**
   * Release the current page (and its parser window). Optional: a session
   * that is simply dropped is cleaned up once it is garbage-collected. After
   * close() the driver has no page until the next visit().
   */
  async close(): Promise<void> {
    await this.browser.close();
  }

  // --- Scoping ---

  async within(
    selector: string,
  ): Promise<TestDriver<RequestStepContext, RequestPage>> {
    const selectors = [...this.scopeSelectors, selector];
    // Resolve now so a scope that matches nothing fails at within(), not at
    // the first step inside it.
    this.resolveScope(selectors);
    return this.scoped(selectors);
  }

  // --- Debug ---

  /** Prints where the session is and the scope's HTML (the whole document
   * when unscoped), with password values hidden. */
  async debug(): Promise<void> {
    const scope =
      this.resolveScope() ?? this.browser.current.document.documentElement;
    const copy = scope.cloneNode(true) as Element;
    for (const input of Array.from(
      copy.querySelectorAll('input[type="password"]'),
    )) {
      if (input.hasAttribute("value")) {
        input.setAttribute("value", HIDDEN_VALUE);
      }
    }
    const where = this.scopeSelectors.length
      ? ` within('${this.scopeSelectors.join("' > '")}')`
      : "";
    console.log(
      `--- debug() at ${this.browser.describe()}${where} ---\n${copy.outerHTML}`,
    );
  }
}

function isInput(el: Element, type: string): boolean {
  return el.tagName === "INPUT" && inputType(el) === type;
}

/** 'an <input type="text">', for messages about the wrong kind of field. */
function describeTag(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return tag === "input" ? `an <input type="${inputType(el)}">` : `a <${tag}>`;
}

/** What an option is called: its label attribute, else its text. */
function optionLabel(option: HTMLOptionElement): string {
  return normalize(option.getAttribute("label") ?? option.textContent ?? "");
}

function quoteList(items: string[]): string {
  return items.map((item) => `'${item}'`).join(", ");
}

/** Long page text, cut down for an error message. */
function preview(text: string, max = 300): string {
  return `'${text.length > max ? `${text.slice(0, max)}…` : text}'`;
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/** The type a browser gives a picked file, from its extension. */
function mimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
