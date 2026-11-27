// SPDX-License-Identifier: AGPL-3.0-or-later
// The mapping of Playwright's failures follows T3 Code v0.1.13,
// apps/server/src/preview/ServerBrowserPage.ts, `toOperationError` (MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see this package's NOTICE).
import { BrowserHostError } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { errors } from "playwright-core";

const isHostError = Schema.is(BrowserHostError);

const MAX_DETAIL = 500;

// Playwright colours its call log with ANSI escapes when colour is on.
const ESCAPES = /\u001b\[[\d;]*m/g;

const firstLine = (message: string) => (message.split("\n")[0] ?? message).slice(0, MAX_DETAIL);

/** Playwright puts why an element was not actionable in its call log, below the first line. */
const actionabilityReason = (message: string) =>
  message
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("- element is "))
    ?.slice(2);

/**
 * A page host's failure for what Playwright or the page threw. Its detail
 * is the first line of Playwright's own message, which names the call and
 * the target, never a value typed into the page.
 */
export const hostErrorOf = (cause: unknown): BrowserHostError => {
  if (isHostError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const line = firstLine(message.replace(ESCAPES, ""));
  if (cause instanceof errors.TimeoutError) {
    const reason = actionabilityReason(message);
    return new BrowserHostError({
      reason: "timeout",
      detail: reason === undefined ? line : `${line} Playwright last saw: ${reason}.`,
    });
  }
  if (
    /Target page, context or browser has been closed|Target closed|has been closed/i.test(message)
  )
    return new BrowserHostError({ reason: "closed" });
  if (/while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message))
    return new BrowserHostError({ reason: "invalid-target", detail: line });
  if (/not an <input>|not editable|not an editable|not a <select>/i.test(message))
    return new BrowserHostError({ reason: "not-editable", detail: line });
  return new BrowserHostError({ reason: "page", detail: line });
};
