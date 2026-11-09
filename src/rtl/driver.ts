import {
  fireEvent,
  getConfig,
  getDefaultNormalizer,
  screen,
  waitFor,
  within as rtlWithin,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type {
  AssertHasOptions,
  AssertionOptions,
  DownloadOptions,
  FieldState,
  StepOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";
import { BrowserOnlyVerbError } from "../errors.js";
import { withinCountMessage } from "../types.js";
import { HIDDEN_VALUE } from "../secrets.js";

/** The scoped query object raw() callbacks receive in the RTL adapter. */
export type RTLQueries = ReturnType<typeof rtlWithin>;

/** Context handed to custom step() callbacks in the RTL adapter. */
export interface RTLStepContext {
  user: UserEvent;
  /** Current scope: `screen`, or a within()-scoped query container. */
  container: ReturnType<typeof rtlWithin> | typeof screen;
}

/**
 * A tree a scoped step searches: the scope element itself, or the open
 * shadow root of a scope element that is a shadow host.
 */
export type ScopeRoot = HTMLElement | ShadowRoot;

/** A Testing Library lookup, as a single match and as every match. */
interface Lookup {
  /** The getBy* query: one element, or Testing Library's own error. */
  get(queries: RTLQueries): HTMLElement;
  /** The queryAllBy* query, for searching several trees at once. */
  all(queries: RTLQueries): HTMLElement[];
}

/** A budget of 0 means no limit; waitFor needs a number. */
const NO_LIMIT = 2 ** 31 - 1;

type ValueElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

/**
 * RTL adapter implementing the subset of TestDriver that applies in JSDOM.
 * Navigation methods (visit, assertPath, refutePath) are not supported.
 *
 * Everything a host adapter is likely to specialize is `protected`: the
 * label-to-control lookup (`findField`), the scoped-driver factory
 * (`scoped`), and the `user` / `root` / `lastFormElement` state the verbs
 * share. Subclass it rather than reimplementing the DSL when an app's markup
 * needs a different lookup — that is how feather-testing-postgres binds this
 * driver to markup whose labels are wrapper siblings rather than `htmlFor`
 * targets.
 */
export class RTLDriver implements TestDriver<RTLStepContext, RTLQueries> {
  protected user: UserEvent;
  /**
   * The element this driver starts from: `document.body`, or the element
   * passed to the constructor. Inside within() the scope is looked up from
   * here again at every step (see {@link RTLDriver.rootElement}).
   */
  protected root: HTMLElement;
  /** The within() selectors, outermost first, resolved from `root` at each step. */
  private scopeSelectors: string[] = [];
  protected lastFormElement: HTMLFormElement | null = null;
  /** The field the most recent fillIn() found; null if it found none. */
  protected lastFilledField: HTMLElement | null = null;
  /**
   * The field the last fillIn() or assertValue() resolved, through
   * findField() (which a subclass may override): fieldState() reads this
   * element, so the step and its failure message describe the same one.
   */
  private stepField: { label: string; element: HTMLElement } | null = null;

  /** findField() for a fillIn/assertValue step, remembered for fieldState(). */
  private async stepFieldFor(label: string, opts?: StepOptions): Promise<HTMLElement> {
    this.stepField = null;
    const element = await this.findField(label, opts);
    this.stepField = { label, element };
    return element;
  }
  /** Per-lookup timeout in ms; undefined leaves RTL's own default in place. */
  protected timeout: number | undefined;

  constructor(user?: UserEvent, container?: HTMLElement, timeout?: number) {
    this.user = user ?? userEvent.setup();
    this.root = container ?? document.body;
    this.timeout = timeout;
  }

  /**
   * The scope element, looked up now: `root`, or inside within() the one
   * element its selectors match from `root` (each level through a shadow
   * host's open shadow root too). Throws, naming the count, when a level no
   * longer matches exactly one element.
   */
  protected rootElement(): HTMLElement {
    let element = this.root;
    for (const selector of this.scopeSelectors) {
      const matches = matchesIn(element, selector);
      if (matches.length !== 1) {
        throw new Error(withinCountMessage(selector, matches.length));
      }
      element = matches[0];
    }
    return element;
  }

  /**
   * The trees a step searches: the scope element, plus its open shadow root
   * when it is a shadow host, so its shadow text and its slotted (light)
   * children are both in scope.
   */
  protected scopeRoots(): ScopeRoot[] {
    const element = this.rootElement();
    return element.shadowRoot ? [element, element.shadowRoot] : [element];
  }

  /** Testing Library's queries bound to the scope element, as it is now. */
  protected get container(): RTLQueries {
    return rtlWithin(this.rootElement());
  }

  /**
   * A step's budget in ms: its own timeout, else the session's, else
   * Testing Library's (asyncUtilTimeout, 1000 ms unless configured).
   */
  protected budget(opts?: StepOptions): number {
    const timeout = opts?.timeout ?? this.timeout ?? getConfig().asyncUtilTimeout;
    return timeout === 0 ? NO_LIMIT : timeout;
  }

  /** Options forwarded to every waitFor call: the step's budget. */
  protected waitOpts(opts?: StepOptions): { timeout: number } {
    return { timeout: this.budget(opts) };
  }

  /**
   * Wait for exactly one element `lookup` finds in scope, looking the scope
   * up again on every try. A scope with one tree gets Testing Library's own
   * errors; a shadow host's two trees are searched together.
   */
  private async findOne(lookup: Lookup, opts?: StepOptions): Promise<HTMLElement> {
    return waitFor(() => {
      const roots = this.scopeRoots();
      if (roots.length === 1) return lookup.get(queriesFor(roots[0]));
      const found = [
        ...new Set(roots.flatMap((root) => lookup.all(queriesFor(root)))),
      ];
      if (found.length === 1) return found[0];
      if (found.length === 0) return lookup.get(queriesFor(roots[0]));
      throw new Error(
        `Found ${found.length} matching elements in the scope and its shadow root; ` +
          "narrow the step with within(...).",
      );
    }, this.waitOpts(opts));
  }

  /**
   * The single label-addressed lookup: every labelled verb goes through it,
   * so overriding this one method retargets them all. `opts.timeout` is the
   * step's own budget, when it set one.
   */
  protected async findField(label: string, opts?: StepOptions): Promise<HTMLElement> {
    return this.findOne(
      {
        get: (q) => {
          try {
            return q.getByLabelText(label);
          } catch (byLabel) {
            try {
              return q.getByPlaceholderText(label);
            } catch (byPlaceholder) {
              // Several labelled fields is the fact worth reporting; else
              // the placeholder's error, the last lookup tried.
              throw /multiple elements/i.test(String(byLabel)) ? byLabel : byPlaceholder;
            }
          }
        },
        all: (q) => {
          const labelled = q.queryAllByLabelText(label);
          return labelled.length > 0 ? labelled : q.queryAllByPlaceholderText(label);
        },
      },
      opts,
    );
  }

  private byText(text: string): Lookup {
    return { get: (q) => q.getByText(text), all: (q) => q.queryAllByText(text) };
  }

  private byRole(role: string, name: string): Lookup {
    return {
      get: (q) => q.getByRole(role, { name }),
      all: (q) => q.queryAllByRole(role, { name }),
    };
  }

  /** Subclasses override this so within() yields a driver of their own type. */
  protected scoped(element: HTMLElement): TestDriver<RTLStepContext, RTLQueries> {
    return new RTLDriver(this.user, element, this.timeout);
  }

  async visit(): Promise<void> {
    throw new Error(
      "feather-testing-core: visit() is not available in the RTL adapter: there are no pages, " +
        "only rendered components. Render the component directly, or use the request or Playwright adapter.",
    );
  }

  async reload(): Promise<void> {
    throw new BrowserOnlyVerbError(
      "reload()",
      "Render the component again explicitly, or run the persistence check in a Playwright spec.",
    );
  }

  async click(text: string, opts?: StepOptions): Promise<void> {
    await this.user.click(await this.findOne(this.byText(text), opts));
  }

  async clickLink(text: string, opts?: StepOptions): Promise<void> {
    await this.user.click(await this.findOne(this.byRole("link", text), opts));
  }

  async clickButton(text: string, opts?: StepOptions): Promise<void> {
    await this.user.click(await this.findOne(this.byRole("button", text), opts));
  }

  async fillIn(label: string, value: string, opts?: StepOptions): Promise<void> {
    this.lastFilledField = null;
    const input = await this.stepFieldFor(label, opts);
    this.lastFilledField = input;
    await this.user.clear(input);
    // user.type() reads { and [ as key syntax ({Enter}, [ShiftLeft]); a
    // value is text, so they are doubled to type them literally.
    if (value) await this.user.type(input, value.replace(/[{[]/g, "$&$&"));
    this.lastFormElement = input.closest("form");
  }

  /**
   * Asked before fillIn's step starts, so a password field's value never
   * reaches a step name or onStep event. Waits for the field as fillIn()
   * does; a field that never appears throws, and the session then hides
   * the value and fails the step with that error.
   */
  async fieldIsPassword(label: string, timeout?: number): Promise<boolean> {
    const field = await this.findField(label, { timeout });
    return field instanceof HTMLInputElement && field.type === "password";
  }

  /**
   * The field the failed fillIn() or assertValue() itself resolved (no
   * second lookup, no waiting), read as it is now. Whether it is secret is
   * decided on that element in the same read. Null when the step never
   * found its field.
   */
  async fieldState(label: string): Promise<FieldState | null> {
    if (this.stepField?.label !== label) return null;
    const el = this.stepField.element;
    const input = el instanceof HTMLInputElement ? el : null;
    if (input?.type === "password") return { secret: true };
    return {
      secret: false,
      value: "value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? ""),
      disabled: el.matches(":disabled"),
      readOnly: el.hasAttribute("readonly"),
      visible: isShown(el),
      editable:
        el instanceof HTMLTextAreaElement ||
        (input !== null && !NOT_TYPEABLE_INPUT_TYPES.has(input.type)) ||
        el.isContentEditable,
      kind: input ? `an <input type="${input.type}">` : `a <${el.tagName.toLowerCase()}>`,
    };
  }

  async lastFilledFieldIsPassword(): Promise<boolean> {
    return (
      this.lastFilledField instanceof HTMLInputElement &&
      this.lastFilledField.type === "password"
    );
  }

  async selectOption(label: string, option: string, opts?: StepOptions): Promise<void> {
    const select = await this.findField(label, opts);
    const optionEl = Array.from(
      (select as HTMLSelectElement).querySelectorAll("option"),
    ).find((o) => o.textContent?.trim() === option);
    if (!optionEl) {
      throw new Error(
        `selectOption('${label}', '${option}'): no <option> with text '${option}' found.`,
      );
    }
    await this.user.selectOptions(select, optionEl);
    this.lastFormElement = select.closest("form");
  }

  async check(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = await this.findField(label, opts);
    if (!(checkbox as HTMLInputElement).checked) {
      await this.user.click(checkbox);
    }
    this.lastFormElement = checkbox.closest("form");
  }

  async uncheck(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = await this.findField(label, opts);
    if ((checkbox as HTMLInputElement).checked) {
      await this.user.click(checkbox);
    }
    this.lastFormElement = checkbox.closest("form");
  }

  async choose(label: string, opts?: StepOptions): Promise<void> {
    const radio = await this.findOne(this.byRole("radio", label), opts);
    await this.user.click(radio);
    this.lastFormElement = radio.closest("form");
  }

  async assertSubmitBlocked(label: string): Promise<void> {
    throw new BrowserOnlyVerbError(
      `assertSubmitBlocked('${label}')`,
      "Constraint validation on submit is not modelled here; use the request or Playwright adapter.",
    );
  }

  async submit(): Promise<void> {
    if (!this.lastFormElement) {
      throw new Error(
        "submit() called but no form was previously interacted with.",
      );
    }
    // Prefer an explicit type="submit" element (the DOM's ground truth),
    // then a button whose accessible name contains "submit".
    const submitBtn =
      this.lastFormElement.querySelector(
        'button[type="submit"], input[type="submit"]',
      ) ??
      rtlWithin(this.lastFormElement).queryByRole("button", {
        name: /submit/i,
      });
    if (submitBtn) {
      await this.user.click(submitBtn);
    } else {
      this.lastFormElement.requestSubmit();
    }
  }

  async attachFile(label: string, path: string, opts?: StepOptions): Promise<void> {
    const input = await this.findField(label, opts);
    // JSDOM has no filesystem access; synthesize a File from the basename.
    const name = path.split(/[\\/]/).pop() ?? path;
    const file = new File([""], name);
    await this.user.upload(input as HTMLInputElement, file);
    this.lastFormElement = input.closest("form");
  }

  /** @deprecated Older name for {@link RTLDriver.attachFile}. */
  async upload(label: string, path: string): Promise<void> {
    await this.attachFile(label, path);
  }

  /**
   * Keys are named the Playwright way ('Enter', 'Control+A') and translated
   * to user-event's keyboard syntax, so one spec reads the same on both
   * adapters.
   */
  async pressKey(key: string): Promise<void> {
    await this.user.keyboard(toKeyboardSyntax(key));
  }

  async hover(text: string, opts?: StepOptions): Promise<void> {
    await this.user.hover(await this.findOne(this.byText(text), opts));
  }

  async dropFile(selector: string, path: string): Promise<void> {
    const target = this.rootElement().querySelector(selector);
    if (!target) {
      throw new Error(`dropFile('${selector}'): element not found`);
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const file = new File([""], name);
    fireEvent.drop(target, {
      dataTransfer: {
        files: [file],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
        types: ["Files"],
      },
    });
  }

  async assertHas(
    _selector: string,
    _opts?: AssertHasOptions,
  ): Promise<void> {
    throw new Error(
      "feather-testing-core: assertHas() is not available in the RTL adapter: it addresses " +
        "elements by CSS selector, which Testing Library avoids. Use assertText() instead.",
    );
  }

  async refuteHas(
    _selector: string,
    _opts?: AssertHasOptions,
  ): Promise<void> {
    throw new Error(
      "feather-testing-core: refuteHas() is not available in the RTL adapter: it addresses " +
        "elements by CSS selector, which Testing Library avoids. Use refuteText() instead.",
    );
  }

  async assertText(text: string, opts?: StepOptions): Promise<void> {
    await this.findOne(this.byText(text), opts);
  }

  async assertExactText(
    text: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    const normalize = getDefaultNormalizer();
    const expected = normalize(text);
    await waitFor(
      () => {
        const actual = normalize(this.rootElement().textContent ?? "");
        if (actual !== expected) {
          throw new Error(
            `assertExactText('${text}'): expected normalized text '${expected}', but found '${actual}'.`,
          );
        }
      },
      this.waitOpts(opts),
    );
  }

  /**
   * Eventually absent: passes as soon as no element in scope shows the
   * text; after the budget, fails naming the elements that still do.
   */
  async refuteText(text: string, opts?: StepOptions): Promise<void> {
    const timeout = this.budget(opts);
    await waitFor(
      () => {
        const present = this.scopeRoots().flatMap((root) =>
          queriesFor(root).queryAllByText(text),
        );
        if (present.length > 0) {
          throw new Error(
            `refuteText('${text}'): still present after ${timeout} ms, in ` +
              `${present.length} element${present.length === 1 ? "" : "s"}: ` +
              present
                .map((el) => `<${el.tagName.toLowerCase()}> '${(el.textContent ?? "").trim()}'`)
                .join(", "),
          );
        }
      },
      { timeout, onTimeout: (error) => error },
    );
  }

  async assertAttribute(
    name: string,
    value?: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await waitFor(
      () => {
        const element = this.rootElement();
        const actual = element.getAttribute(name);
        if (value === undefined ? !element.hasAttribute(name) : actual !== value) {
          const expected =
            value === undefined ? "to be present" : `to equal '${value}'`;
          const found = actual === null ? "<missing>" : `'${actual}'`;
          throw new Error(
            `assertAttribute('${name}'): expected attribute '${name}' ${expected}, but found ${found}.`,
          );
        }
      },
      this.waitOpts(opts),
    );
  }

  async refuteAttribute(
    name: string,
    opts?: AssertionOptions,
  ): Promise<void> {
    await waitFor(
      () => {
        const element = this.rootElement();
        if (element.hasAttribute(name)) {
          throw new Error(
            `refuteAttribute('${name}'): expected attribute '${name}' to be absent, but found '${element.getAttribute(name) ?? ""}'.`,
          );
        }
      },
      this.waitOpts(opts),
    );
  }

  async assertComputedStyle(): Promise<void> {
    throw new BrowserOnlyVerbError(
      "assertComputedStyle()",
      "Run this assertion in a Playwright spec so a browser can apply stylesheets and compute CSS.",
    );
  }

  private browserOnlyLayout(verb: string): never {
    throw new BrowserOnlyVerbError(
      `${verb}()`,
      "Run this layout operation in a Playwright spec; JSDOM does not calculate browser geometry.",
    );
  }

  async assertNoHorizontalOverflow(): Promise<void> {
    this.browserOnlyLayout("assertNoHorizontalOverflow");
  }

  async assertHorizontalOverflow(): Promise<void> {
    this.browserOnlyLayout("assertHorizontalOverflow");
  }

  async assertHorizontallyContained(): Promise<void> {
    this.browserOnlyLayout("assertHorizontallyContained");
  }

  async scrollToHorizontalEnd(): Promise<void> {
    this.browserOnlyLayout("scrollToHorizontalEnd");
  }

  async assertValue(label: string, value: string, opts?: StepOptions): Promise<void> {
    const field = await this.stepFieldFor(label, opts);
    await waitFor(() => {
      const actual = (field as ValueElement).value;
      if (actual !== value) {
        throw new Error(
          `assertValue('${label}', '${value}'): expected value '${value}', but found '${actual}'.`,
        );
      }
    }, this.waitOpts(opts));
  }

  async assertChecked(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = await this.findField(label, opts);
    await waitFor(() => {
      if (!(checkbox as HTMLInputElement).checked) {
        throw new Error(
          `assertChecked('${label}'): expected checkbox to be checked, but it was not.`,
        );
      }
    }, this.waitOpts(opts));
  }

  async refuteChecked(label: string, opts?: StepOptions): Promise<void> {
    const checkbox = await this.findField(label, opts);
    await waitFor(() => {
      if ((checkbox as HTMLInputElement).checked) {
        throw new Error(
          `refuteChecked('${label}'): expected checkbox NOT to be checked, but it was.`,
        );
      }
    }, this.waitOpts(opts));
  }

  async assertSelected(label: string, optionLabel: string, opts?: StepOptions): Promise<void> {
    const select = (await this.findField(label, opts)) as HTMLSelectElement;
    await waitFor(() => {
      const selected = select.selectedOptions[0]?.textContent?.trim();
      if (selected !== optionLabel) {
        throw new Error(
          `assertSelected('${label}', '${optionLabel}'): expected selected option '${optionLabel}', but found '${selected ?? "(none)"}'.`,
        );
      }
    }, this.waitOpts(opts));
  }

  async assertOptions(label: string, optionLabels: string[], opts?: StepOptions): Promise<void> {
    const select = (await this.findField(label, opts)) as HTMLSelectElement;
    await waitFor(() => {
      const actual = Array.from(select.querySelectorAll("option")).map(
        (o) => o.textContent?.trim() ?? "",
      );
      const matches =
        actual.length === optionLabels.length &&
        actual.every((text, i) => text === optionLabels[i]);
      if (!matches) {
        throw new Error(
          `assertOptions('${label}'): expected options [${optionLabels.join(", ")}], but found [${actual.join(", ")}].`,
        );
      }
    }, this.waitOpts(opts));
  }

  async assertPath(): Promise<void> {
    throw new Error(
      "feather-testing-core: assertPath() is not available in the RTL adapter: JSDOM has no " +
        "real URL. Assert what the component renders instead, or use the request or Playwright adapter.",
    );
  }

  async refutePath(): Promise<void> {
    throw new Error(
      "feather-testing-core: refutePath() is not available in the RTL adapter: JSDOM has no " +
        "real URL. Assert what the component renders instead, or use the request or Playwright adapter.",
    );
  }

  async assertDownload(
    _expected: string | RegExp,
    _trigger: () => Promise<void>,
    _opts?: DownloadOptions,
  ): Promise<void> {
    throw new BrowserOnlyVerbError(
      "assertDownload()",
      "Assert the request the download would make, or move this case to a " +
        "Playwright spec where a real browser can accept the file.",
    );
  }

  async until(
    description: string,
    predicate: UntilPredicate<RTLStepContext>,
    opts?: UntilOptions,
  ): Promise<void> {
    await waitFor(
      async () => {
        if (!(await predicate(this.context()))) {
          throw new Error(
            `until: ${description} — condition was still not met.`,
          );
        }
      },
      {
        ...this.waitOpts(opts),
        ...(opts?.interval === undefined ? {} : { interval: opts.interval }),
      },
    );
  }

  async step(fn: (context: RTLStepContext) => Promise<unknown>): Promise<void> {
    await fn(this.context());
  }

  /** raw() hands over the scoped query object — `within(root)`, i.e. screen
   * when the driver is unscoped. */
  async raw(
    fn: (queries: RTLQueries) => unknown | Promise<unknown>,
  ): Promise<void> {
    await fn(this.container);
  }

  /** The adapter context handed to step(), until(), and friends. */
  protected context(): RTLStepContext {
    return { user: this.user, container: this.container };
  }

  /**
   * Waits until `selector` matches in scope (through a shadow host's open
   * shadow root too), then requires exactly one match. The scoped driver
   * keeps the selector, not the element: every step inside looks it up
   * again, so a scope React re-renders as a new element still works.
   */
  async within(
    selector: string,
    opts?: StepOptions,
  ): Promise<TestDriver<RTLStepContext, RTLQueries>> {
    const matches = await waitFor(
      () => {
        const found = matchesIn(this.rootElement(), selector);
        if (found.length === 0) throw new Error(withinCountMessage(selector, 0));
        return found;
      },
      { ...this.waitOpts(opts), onTimeout: (error) => error },
    );
    if (matches.length !== 1) {
      throw new Error(withinCountMessage(selector, matches.length));
    }
    const scoped = this.scoped(matches[0]);
    if (scoped instanceof RTLDriver) {
      scoped.root = this.root;
      scoped.scopeSelectors = [...this.scopeSelectors, selector];
    }
    return scoped;
  }

  /**
   * Prints a copy of the DOM with password values hidden: React writes a
   * controlled input's value into its `value` attribute, which the print
   * would otherwise show.
   */
  async debug(): Promise<void> {
    const copy = this.rootElement().cloneNode(true) as HTMLElement;
    for (const input of copy.querySelectorAll('input[type="password"]')) {
      if (input.hasAttribute("value")) {
        input.setAttribute("value", HIDDEN_VALUE);
      }
    }
    screen.debug(copy);
  }
}

/** Every element `selector` matches under `element`, and in its open shadow root. */
function matchesIn(element: HTMLElement, selector: string): HTMLElement[] {
  const light = Array.from(element.querySelectorAll<HTMLElement>(selector));
  const shadow = element.shadowRoot
    ? Array.from(element.shadowRoot.querySelectorAll<HTMLElement>(selector))
    : [];
  return [...light, ...shadow];
}

/** Testing Library's queries on one tree (a shadow root is a valid container). */
function queriesFor(root: ScopeRoot): RTLQueries {
  return rtlWithin(root as HTMLElement);
}

/** Playwright key names -> user-event keyboard syntax. */
const KEY_ALIASES: Record<string, string> = {
  Ctrl: "Control",
  Cmd: "Meta",
  Command: "Meta",
  Space: " ",
};

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * 'Enter' -> '{Enter}', 'a' -> 'a', 'Control+A' -> '{Control>}A{/Control}'.
 * Printable characters are typed literally with user-event's own `{` and `[`
 * escapes applied, so a key name never turns into a descriptor by accident.
 */
export function toKeyboardSyntax(key: string): string {
  const parts = key.split("+").map((p) => KEY_ALIASES[p] ?? p);
  const target = parts.pop();
  if (target === undefined || target === "") {
    throw new Error(`pressKey('${key}'): no key to press.`);
  }
  const held = parts.filter((p) => MODIFIERS.has(p));
  if (held.length !== parts.length) {
    throw new Error(
      `pressKey('${key}'): '${parts.find((p) => !MODIFIERS.has(p))}' is not a ` +
        "modifier. Use Control, Shift, Alt, or Meta.",
    );
  }
  const pressed =
    target.length === 1
      ? target.replace(/[{[]/g, (c) => c + c)
      : `{${target}}`;
  return (
    held.map((m) => `{${m}>}`).join("") +
    pressed +
    held
      .slice()
      .reverse()
      .map((m) => `{/${m}}`)
      .join("")
  );
}

/** Input types fillIn() cannot type into (the other adapters' list too). */
const NOT_TYPEABLE_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "file",
  "submit",
  "reset",
  "button",
  "image",
  "hidden",
]);

/** Not hidden by an attribute or by display/visibility, on it or an ancestor. */
function isShown(element: HTMLElement): boolean {
  for (let el: HTMLElement | null = element; el; el = el.parentElement) {
    if (el.hidden) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style?.display === "none") return false;
    if (el === element && style?.visibility === "hidden") return false;
  }
  return true;
}
