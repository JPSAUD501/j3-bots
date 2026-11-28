// SPDX-License-Identifier: AGPL-3.0-or-later
// The focus, field and option checks follow T3 Code v0.1.13,
// apps/server/src/preview/ServerBrowserPage.ts (MIT License, Copyright (c) 2026 T3 Tools Inc.;
// see this package's NOTICE).
//
// Functions that run in the page. Playwright sends each one's source, so none may use
// anything outside its own body. What they return comes from the page, whose script can
// change what they read: a caller checks it before trusting it.
//
// The page's own names are declared here, for this module alone: the few parts of the DOM
// these functions use. A program that imports the driver, such as the server's, has no DOM
// library, and must not get one, since its `fetch` and its streams are Node's. A program
// that has one, or has empty stand-ins for its names, gives Playwright's handles element
// types of its own; so a function an element is passed to takes it as unknown and checks
// it with these names, in the page.

/** The parts of a DOM node these functions use. */
interface PageNode {
  readonly isConnected: boolean;
  getRootNode(): PageNode;
}

/** The parts of a DOM element these functions use: what every element has, SVG's too. */
interface PageElement extends PageNode {
  readonly tagName: string;
  readonly shadowRoot: PageShadowRoot | null;
  closest(selectors: string): PageElement | null;
  contains(other: PageNode | null): boolean;
  scrollBy(x: number, y: number): void;
}

interface PageHTMLElement extends PageElement {
  readonly isContentEditable: boolean;
  readonly innerText: string;
  focus(): void;
}

interface PageInputElement extends PageHTMLElement {
  readonly type: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  value: string;
  /** Null for a type with no text selection, such as `email` or `number`. */
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  select(): void;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  dispatchEvent(event: PageEvent): boolean;
}

/** An event, as a script makes one to tell the page a field changed. */
interface PageEvent {
  readonly type: string;
}

interface PageTextAreaElement extends PageHTMLElement {
  readonly disabled: boolean;
  readonly readOnly: boolean;
}

interface PageLabelElement extends PageHTMLElement {
  readonly control: PageHTMLElement | null;
}

interface PageSelectElement extends PageHTMLElement {
  readonly options: ArrayLike<{ readonly value: string; readonly label: string }>;
}

interface PageShadowRoot extends PageNode {
  readonly activeElement: PageElement | null;
  elementFromPoint(x: number, y: number): PageElement | null;
}

interface PageDocument extends PageNode {
  readonly activeElement: PageElement | null;
  readonly body: PageHTMLElement | null;
  readonly title: string;
  readonly readyState: string;
  elementFromPoint(x: number, y: number): PageElement | null;
  execCommand(command: string, showUi: boolean, value: string): boolean;
}

/** A DOM interface as `instanceof` checks against it. */
interface PageClass<T> {
  new (): T;
  readonly prototype: T;
}

declare const document: PageDocument;
declare const Document: PageClass<PageDocument>;
declare const Element: PageClass<PageElement>;
declare const ShadowRoot: PageClass<PageShadowRoot>;
declare const HTMLElement: PageClass<PageHTMLElement>;
declare const HTMLInputElement: PageClass<PageInputElement>;
declare const HTMLTextAreaElement: PageClass<PageTextAreaElement>;
declare const HTMLLabelElement: PageClass<PageLabelElement>;
declare const HTMLSelectElement: PageClass<PageSelectElement>;
declare const Event: new (type: string, init: { readonly bubbles: boolean }) => PageEvent;
declare const location: { readonly href: string };
declare const getComputedStyle: (element: PageElement) => { readonly visibility: string };
declare const innerWidth: number;
declare const innerHeight: number;
declare const devicePixelRatio: number;
declare const scrollBy: (x: number, y: number) => void;

/**
 * Focuses the target, or the element in focus when there is none, if it
 * takes typed text, and says whether focus is now in it.
 */
export const focusTextTarget = (target: unknown): boolean => {
  const nonText = [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ];
  if (target !== null && !(target instanceof Element)) return false;
  let element = target ?? document.activeElement;
  if (target === null) {
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    // Focus inside a frame cannot be checked from here, and an editable frame would pass as editable.
    if (element && ["IFRAME", "FRAME", "FENCEDFRAME", "OBJECT", "EMBED"].includes(element.tagName))
      return false;
  }
  if (!(element instanceof HTMLElement)) return false;
  const field =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !nonText.includes(element.type));
  if (!(field || element.isContentEditable)) return false;
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    (element.disabled || element.readOnly)
  )
    return false;
  element.focus();
  const root = element.getRootNode();
  const active = root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
  return active !== null && (active === element || element.contains(active));
};

/** Whether the target is, or labels, a picker or slider, which takes its value only from fill. */
export const isValueOnlyInput = (target: unknown): boolean => {
  if (!(target instanceof Element)) return false;
  const label = target.closest("label");
  const element =
    target instanceof HTMLLabelElement
      ? target.control
      : ((label instanceof HTMLLabelElement ? label.control : null) ?? target);
  return (
    element instanceof HTMLInputElement &&
    ["color", "date", "datetime-local", "month", "range", "time", "week"].includes(element.type)
  );
};

/** A `<select>`'s options, or null for any other element. */
export const selectOptions = (
  element: unknown,
): ReadonlyArray<{ readonly value: string; readonly label: string }> | null =>
  element instanceof HTMLSelectElement
    ? Array.from(element.options, ({ value, label }) => ({ value, label: label.trim() }))
    : null;

/** Whether the point, in CSS pixels, lands in a field that takes typed text. */
export const editableAt = ([x, y]: readonly [number, number]): boolean => {
  const nonText = [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ];
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (inner === null || inner === element) break;
    element = inner;
  }
  if (element === null) return false;
  const field = element.closest("input, textarea, [contenteditable]") ?? element;
  if (field instanceof HTMLElement && field.isContentEditable) return true;
  if (field instanceof HTMLTextAreaElement) return !field.disabled && !field.readOnly;
  return (
    field instanceof HTMLInputElement &&
    !nonText.includes(field.type) &&
    !field.disabled &&
    !field.readOnly
  );
};

/** Whether the page's visible text holds `text`. */
export const pageHasText = (text: string): boolean =>
  (document.body?.innerText ?? "").includes(text);

export const scrollPage = ([x, y]: readonly [number, number]): void => {
  scrollBy(x, y);
};

export const scrollElement = (element: unknown, [x, y]: readonly [number, number]): void => {
  if (element instanceof Element) element.scrollBy(x, y);
};

export const documentState = () => ({
  title: document.title,
  loading: document.readyState !== "complete",
});

export const viewportSize = () => ({
  width: innerWidth,
  height: innerHeight,
  ratio: devicePixelRatio,
});

/** Whether the element is still in its document. */
export const isConnected = (element: unknown): boolean =>
  element instanceof Element && element.isConnected;

// ---------------------------------------------------------------------------
// Typing a saved login. These run in an isolated world of the page's top frame,
// whose names and prototypes the page's own script cannot reach.

/** The field a saved login types into: an input the page shows in its top frame. */
export type FillInput = PageInputElement;

/**
 * Types `value` into the focused field, in one step with the checks that it
 * may: the page is at `url`, loaded, and its focus is on an input of its top
 * frame (through open shadow roots) that `field` fits, shown and taking
 * input. Nothing of the page's runs between the checks and the typing, so
 * the page cannot move the focus in between. The value goes in through the
 * document's own editing, which can only reach this document: never an
 * embedded frame's. Focus inside an embedded frame leaves the frame's
 * element focused here, which is no input.
 *
 * Answers the field once the value is in it, exactly as typed; why not when
 * nothing was typed; `missed` when the field took it otherwise, after it is
 * put back as it was.
 */
export const typeLogin = (
  field: string,
  url: string,
  value: string,
): PageInputElement | "field" | "navigated" | "loading" | "missed" => {
  const fits: Readonly<Record<string, ReadonlyArray<string>>> = {
    username: ["text", "email", "tel"],
    password: ["password"],
    totp: ["text", "tel", "number", "password"],
  };
  if (location.href !== url) return "navigated";
  if (document.readyState !== "complete") return "loading";
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!(element instanceof HTMLInputElement)) return "field";
  if (!(fits[field] ?? []).includes(element.type) || element.disabled || element.readOnly)
    return "field";
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1 || getComputedStyle(element).visibility !== "visible")
    return "field";
  const before = element.value;
  const start = element.selectionStart ?? before.length;
  const end = element.selectionEnd ?? before.length;
  const expected = before.slice(0, start) + value + before.slice(end);
  if (!document.execCommand("insertText", false, value)) return "field";
  if (element.isConnected && element.value === expected) return element;
  // The field took the value otherwise than typed (a `maxlength` cut it, or
  // the page rewrote it): what it holds now goes, so no part of a value is
  // left behind or submitted.
  element.value = before;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return "missed";
};

/** Whether the field left its page or the page emptied it itself. */
export const fieldGone = (field: PageInputElement): boolean =>
  !field.isConnected || field.value.length === 0;

/**
 * Empties the field and says whether it is empty: selected and deleted
 * through the document's editing, as a person's Backspace would, in one step
 * so the deletion cannot land elsewhere; then emptied outright if the page
 * kept anything.
 */
export const emptyField = (field: PageInputElement): boolean => {
  if (!field.isConnected) return true;
  field.focus();
  field.select();
  document.execCommand("delete", false, "");
  if (field.value.length > 0) {
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return field.value.length === 0;
};
