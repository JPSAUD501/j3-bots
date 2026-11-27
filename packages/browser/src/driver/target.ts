// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ElementHandle, Locator } from "playwright-core";
import { BrowserHostError } from "@j3-bots/contracts";
import {
  focusTextTarget,
  isConnected,
  isValueOnlyInput,
  type PageElement,
  scrollElement,
  selectOptions,
} from "./pageScripts.ts";

/**
 * What an action points at, as the bot named it: the one element a ref
 * named, or whatever a selector matches when the action runs. Each step
 * waits as Playwright's actions wait, up to the time it is given.
 */
export interface Target {
  /** The target as the bot wrote it. */
  readonly name: string;
  readonly click: (options: {
    readonly button: "left" | "right" | "middle";
    readonly clickCount: number;
    readonly timeout: number;
  }) => Promise<void>;
  readonly hover: (timeout: number) => Promise<void>;
  readonly fill: (value: string, timeout: number) => Promise<void>;
  readonly selectOption: (values: ReadonlyArray<string>, timeout: number) => Promise<Array<string>>;
  readonly setInputFiles: (paths: ReadonlyArray<string>, timeout: number) => Promise<void>;
  readonly scrollIntoView: (timeout: number) => Promise<void>;
  readonly box: (
    timeout: number,
  ) => Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Focuses it if it takes typed text; whether focus is now in it. */
  readonly focusText: () => Promise<boolean>;
  /** Whether it is, or labels, a picker or slider. */
  readonly valueOnly: () => Promise<boolean>;
  /** Its options, if it is a `<select>`; read from the page, so checked by the caller. */
  readonly options: () => Promise<unknown>;
  readonly scrollBy: (x: number, y: number) => Promise<void>;
  /** How many elements it matches now. */
  readonly count: () => Promise<number>;
}

export const locatorTarget = (name: string, locator: Locator): Target => ({
  name,
  click: (options) => locator.click(options),
  hover: (timeout) => locator.hover({ timeout }),
  fill: (value, timeout) => locator.fill(value, { timeout }),
  selectOption: (values, timeout) => locator.selectOption([...values], { timeout }),
  setInputFiles: (paths, timeout) => locator.setInputFiles([...paths], { timeout }),
  scrollIntoView: (timeout) => locator.scrollIntoViewIfNeeded({ timeout }),
  box: (timeout) => locator.boundingBox({ timeout }),
  focusText: () => locator.evaluate(focusTextTarget),
  valueOnly: () => locator.evaluate(isValueOnlyInput),
  options: () => locator.evaluate(selectOptions),
  scrollBy: (x, y) => locator.evaluate(scrollElement, [x, y] as const),
  count: () => locator.count(),
});

// Playwright's words for an element no longer in its document, or a handle of a page that left.
const GONE =
  /not attached to the DOM|Element is detached|has been disposed|Execution context was destroyed/i;

/** An element that left its document is one the ref no longer names. */
const onElement = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Error && GONE.test(cause.message))
      throw new BrowserHostError({ reason: "stale-ref" });
    throw cause;
  }
};

export const handleTarget = (name: string, handle: ElementHandle<PageElement>): Target => ({
  name,
  click: (options) => onElement(() => handle.click(options)),
  hover: (timeout) => onElement(() => handle.hover({ timeout })),
  fill: (value, timeout) => onElement(() => handle.fill(value, { timeout })),
  selectOption: (values, timeout) => onElement(() => handle.selectOption([...values], { timeout })),
  setInputFiles: (paths, timeout) => onElement(() => handle.setInputFiles([...paths], { timeout })),
  scrollIntoView: (timeout) => onElement(() => handle.scrollIntoViewIfNeeded({ timeout })),
  box: () => onElement(() => handle.boundingBox()),
  focusText: () => onElement(() => handle.evaluate(focusTextTarget)),
  valueOnly: () => onElement(() => handle.evaluate(isValueOnlyInput)),
  options: () => onElement(() => handle.evaluate(selectOptions)),
  scrollBy: (x, y) => onElement(() => handle.evaluate(scrollElement, [x, y] as const)),
  count: () =>
    onElement(() => handle.evaluate(isConnected)).then((connected) => (connected ? 1 : 0)),
});
