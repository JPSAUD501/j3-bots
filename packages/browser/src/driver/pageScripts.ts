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
// library, and must not get one, since its `fetch` and its streams are Node's.

/** The parts of a DOM node these functions use. */
export interface PageNode {
  readonly isConnected: boolean;
  getRootNode(): PageNode;
}

/** The parts of a DOM element these functions use: what every element has, SVG's too. */
export interface PageElement extends PageNode {
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
}

/** A DOM interface as `instanceof` checks against it. */
interface PageClass<T> {
  new (): T;
  readonly prototype: T;
}

declare const document: PageDocument;
declare const Document: PageClass<PageDocument>;
declare const ShadowRoot: PageClass<PageShadowRoot>;
declare const HTMLElement: PageClass<PageHTMLElement>;
declare const HTMLInputElement: PageClass<PageInputElement>;
declare const HTMLTextAreaElement: PageClass<PageTextAreaElement>;
declare const HTMLLabelElement: PageClass<PageLabelElement>;
declare const HTMLSelectElement: PageClass<PageSelectElement>;
declare const innerWidth: number;
declare const innerHeight: number;
declare const devicePixelRatio: number;
declare const scrollBy: (x: number, y: number) => void;

/**
 * Focuses the target, or the element in focus when there is none, if it
 * takes typed text, and says whether focus is now in it.
 */
export const focusTextTarget = (target: PageElement | null): boolean => {
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
export const isValueOnlyInput = (target: PageElement): boolean => {
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
  element: PageElement,
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

export const scrollElement = (element: PageElement, [x, y]: readonly [number, number]): void => {
  element.scrollBy(x, y);
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
export const isConnected = (element: PageElement): boolean => element.isConnected;
