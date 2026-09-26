import {
  fireEvent,
  getDefaultNormalizer,
  screen,
  waitFor,
  within as rtlWithin,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type {
  AssertExactTextOptions,
  AssertHasOptions,
  AssertionOptions,
  DownloadOptions,
  TestDriver,
  UntilOptions,
  UntilPredicate,
} from "../types.js";
import { BrowserOnlyVerbError } from "../errors.js";

/** The scoped query object raw() callbacks receive in the RTL adapter. */
export type RTLQueries = ReturnType<typeof rtlWithin>;

/** Context handed to custom step() callbacks in the RTL adapter. */
export interface RTLStepContext {
  user: UserEvent;
  /** Current scope: `screen`, or a within()-scoped query container. */
  container: ReturnType<typeof rtlWithin> | typeof screen;
}

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
  /** The element every query and selector in this driver resolves against. */
  protected root: HTMLElement;
  protected container: ReturnType<typeof rtlWithin>;
  protected lastFormElement: HTMLFormElement | null = null;
  /** Per-lookup timeout in ms; undefined leaves RTL's own default in place. */
  protected timeout: number | undefined;

  constructor(user?: UserEvent, container?: HTMLElement, timeout?: number) {
    this.user = user ?? userEvent.setup();
    this.root = container ?? document.body;
    this.container = rtlWithin(this.root);
    this.timeout = timeout;
  }

  protected rootElement(): HTMLElement {
    return this.root;
  }

  /** Options forwarded to every async query and waitFor call. */
  protected waitOpts(): { timeout?: number } {
    return this.timeout === undefined ? {} : { timeout: this.timeout };
  }

  /**
   * The single label-addressed lookup: every labelled verb goes through it,
   * so overriding this one method retargets them all.
   */
  protected async findField(label: string): Promise<HTMLElement> {
    try {
      return await this.container.findByLabelText(
        label,
        undefined,
        this.waitOpts(),
      );
    } catch {
      return await this.container.findByPlaceholderText(
        label,
        undefined,
        this.waitOpts(),
      );
    }
  }

  /** Subclasses override this so within() yields a driver of their own type. */
  protected scoped(element: HTMLElement): TestDriver<RTLStepContext, RTLQueries> {
    return new RTLDriver(this.user, element, this.timeout);
  }

  async visit(): Promise<void> {
    throw new Error(
      "visit() is not available in the RTL adapter. Render the desired component directly.",
    );
  }

  async reload(): Promise<void> {
    throw new BrowserOnlyVerbError(
      "reload()",
      "Render the component again explicitly, or run the persistence check in a Playwright spec.",
    );
  }

  async click(text: string): Promise<void> {
    const element = await this.container.findByText(
      text,
      undefined,
      this.waitOpts(),
    );
    await this.user.click(element);
  }

  async clickLink(text: string): Promise<void> {
    const link = await this.container.findByRole(
      "link",
      { name: text },
      this.waitOpts(),
    );
    await this.user.click(link);
  }

  async clickButton(text: string): Promise<void> {
    const button = await this.container.findByRole(
      "button",
      { name: text },
      this.waitOpts(),
    );
    await this.user.click(button);
  }

  async fillIn(label: string, value: string): Promise<void> {
    const input = await this.findField(label);
    await this.user.clear(input);
    if (value) await this.user.type(input, value);
    this.lastFormElement = input.closest("form");
  }

  async selectOption(label: string, option: string): Promise<void> {
    const select = await this.findField(label);
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

  async check(label: string): Promise<void> {
    const checkbox = await this.findField(label);
    if (!(checkbox as HTMLInputElement).checked) {
      await this.user.click(checkbox);
    }
    this.lastFormElement = checkbox.closest("form");
  }

  async uncheck(label: string): Promise<void> {
    const checkbox = await this.findField(label);
    if ((checkbox as HTMLInputElement).checked) {
      await this.user.click(checkbox);
    }
    this.lastFormElement = checkbox.closest("form");
  }

  async choose(label: string): Promise<void> {
    const radio = await this.container.findByRole(
      "radio",
      { name: label },
      this.waitOpts(),
    );
    await this.user.click(radio);
    this.lastFormElement = radio.closest("form");
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

  async attachFile(label: string, path: string): Promise<void> {
    const input = await this.findField(label);
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

  async hover(text: string): Promise<void> {
    const element = await this.container.findByText(
      text,
      undefined,
      this.waitOpts(),
    );
    await this.user.hover(element);
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
      "assertHas() with CSS selectors is not recommended in RTL. Use assertText() instead.",
    );
  }

  async refuteHas(
    _selector: string,
    _opts?: AssertHasOptions,
  ): Promise<void> {
    throw new Error(
      "refuteHas() with CSS selectors is not recommended in RTL. Use refuteText() instead.",
    );
  }

  async assertText(text: string): Promise<void> {
    await this.container.findByText(text, undefined, this.waitOpts());
  }

  async assertExactText(
    text: string,
    opts?: AssertExactTextOptions,
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
      opts?.timeout === undefined ? this.waitOpts() : { timeout: opts.timeout },
    );
  }

  async refuteText(text: string): Promise<void> {
    await waitFor(() => {
      const el = this.container.queryByText(text);
      if (el) {
        throw new Error(
          `Expected NOT to find text '${text}', but it was present.`,
        );
      }
    }, this.waitOpts());
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
      opts?.timeout === undefined ? this.waitOpts() : { timeout: opts.timeout },
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
      opts?.timeout === undefined ? this.waitOpts() : { timeout: opts.timeout },
    );
  }

  async assertComputedStyle(): Promise<void> {
    throw new BrowserOnlyVerbError(
      "assertComputedStyle()",
      "Run this assertion in a Playwright spec so a browser can apply stylesheets and compute CSS.",
    );
  }

  async assertValue(label: string, value: string): Promise<void> {
    const field = await this.findField(label);
    await waitFor(() => {
      const actual = (field as ValueElement).value;
      if (actual !== value) {
        throw new Error(
          `assertValue('${label}', '${value}'): expected value '${value}', but found '${actual}'.`,
        );
      }
    }, this.waitOpts());
  }

  async assertChecked(label: string): Promise<void> {
    const checkbox = await this.findField(label);
    await waitFor(() => {
      if (!(checkbox as HTMLInputElement).checked) {
        throw new Error(
          `assertChecked('${label}'): expected checkbox to be checked, but it was not.`,
        );
      }
    }, this.waitOpts());
  }

  async refuteChecked(label: string): Promise<void> {
    const checkbox = await this.findField(label);
    await waitFor(() => {
      if ((checkbox as HTMLInputElement).checked) {
        throw new Error(
          `refuteChecked('${label}'): expected checkbox NOT to be checked, but it was.`,
        );
      }
    }, this.waitOpts());
  }

  async assertSelected(label: string, optionLabel: string): Promise<void> {
    const select = (await this.findField(label)) as HTMLSelectElement;
    await waitFor(() => {
      const selected = select.selectedOptions[0]?.textContent?.trim();
      if (selected !== optionLabel) {
        throw new Error(
          `assertSelected('${label}', '${optionLabel}'): expected selected option '${optionLabel}', but found '${selected ?? "(none)"}'.`,
        );
      }
    }, this.waitOpts());
  }

  async assertOptions(label: string, optionLabels: string[]): Promise<void> {
    const select = (await this.findField(label)) as HTMLSelectElement;
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
    }, this.waitOpts());
  }

  async assertPath(): Promise<void> {
    throw new Error(
      "assertPath() is not available in the RTL adapter (no real URL in JSDOM).",
    );
  }

  async refutePath(): Promise<void> {
    throw new Error(
      "refutePath() is not available in the RTL adapter (no real URL in JSDOM).",
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
        ...this.waitOpts(),
        ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
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

  async within(
    selector: string,
  ): Promise<TestDriver<RTLStepContext, RTLQueries>> {
    const element = this.rootElement().querySelector(selector);
    if (!element) throw new Error(`within('${selector}'): element not found`);
    return this.scoped(element as HTMLElement);
  }

  async debug(): Promise<void> {
    screen.debug(this.rootElement());
  }
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
