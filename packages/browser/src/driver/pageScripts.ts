// SPDX-License-Identifier: AGPL-3.0-or-later
// The focus, field and option checks follow T3 Code v0.1.13,
// apps/server/src/preview/ServerBrowserPage.ts (MIT License, Copyright (c) 2026 T3 Tools Inc.;
// see this package's NOTICE).
//
// Functions that run in the page. Playwright sends each one's source, so none may use
// anything outside its own body. What they return comes from the page, whose script can
// change what they read: a caller checks it before trusting it.

/**
 * Focuses the target, or the element in focus when there is none, if it
 * takes typed text, and says whether focus is now in it.
 */
export const focusTextTarget = (target: Element | null): boolean => {
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
export const isValueOnlyInput = (target: Element): boolean => {
  const element =
    target instanceof HTMLLabelElement
      ? target.control
      : (target.closest("label")?.control ?? target);
  return (
    element instanceof HTMLInputElement &&
    ["color", "date", "datetime-local", "month", "range", "time", "week"].includes(element.type)
  );
};

/** A `<select>`'s options, or null for any other element. */
export const selectOptions = (
  element: Element,
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

export const scrollElement = (element: Element, [x, y]: readonly [number, number]): void => {
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
