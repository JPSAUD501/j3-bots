// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { BotId, Label, NonNegativeInt } from "./base.ts";
import { BrowserDialog, BrowserTabRef } from "./browser.ts";

// The `browser_*` tools a bot uses J3 Bots' browser through (decision 0110),
// and the page work a page host does for them (`browserHost.ts`). Their names
// and arguments mirror the engine's own browser tools, so a model that knows
// one knows the other. Each tool's description is prompt text and lives with
// the other tools in `packages/prompts`; this file holds only their shapes.

/** The tools, in the order a bot reads them. */
export const BROWSER_TOOL_NAMES = [
  "browser_tabs",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_evaluate",
  "browser_wait_for",
  "browser_dialog",
  "browser_close",
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/** What a step waits for when the call names no `timeoutMs`. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
/** The longest a call may ask one step to wait. */
export const MAX_BROWSER_TIMEOUT_MS = 60_000;
/** The longest accessibility tree a snapshot returns, cut after masking. */
export const MAX_BROWSER_SNAPSHOT_LENGTH = 20_000;
/** The most an evaluation may return, as UTF-8 JSON. */
export const MAX_BROWSER_EVALUATE_RESULT_BYTES = 64_000;
/**
 * The longest expression `browser_evaluate` takes: well inside what a tool
 * call may carry through the engine.
 */
export const MAX_BROWSER_EXPRESSION_LENGTH = 10_000;
/** The longest text one `type` action types. */
export const MAX_BROWSER_TYPE_LENGTH = 10_000;
/** The longest locator or address a call takes. */
const MAX_LOCATOR_LENGTH = 1_024;
const MAX_ADDRESS_LENGTH = 2_048;

const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_TIMEOUT_MS }));

/**
 * An element on the page: `aria-ref=<ref>` with a ref from the latest
 * snapshot, or any Playwright locator, such as `text=Sign in`. A ref from an
 * earlier snapshot, or from before the page changed, is refused.
 */
export const BrowserLocator = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_LOCATOR_LENGTH),
);

/** A point on the page, in its CSS pixels. */
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

/**
 * An address a bot opens: absolute `http:` or `https:`, or a bare host,
 * which opens as `https:` (`http:` on a loopback host). The host refuses
 * any other scheme.
 */
export const BrowserAddress = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ADDRESS_LENGTH),
);

export const BrowserKeyModifier = Schema.Literals(["Alt", "Control", "Meta", "Shift"]);
export type BrowserKeyModifier = typeof BrowserKeyModifier.Type;

/** How long `open` and `navigate` wait: the `load` event (the default), the DOM, or not at all. */
export const BrowserReadiness = Schema.Literals(["load", "domContentLoaded", "none"]);
export type BrowserReadiness = typeof BrowserReadiness.Type;

// ---------------------------------------------------------------------------
// Actions on a page

const exactlyOneTarget = Schema.makeFilter(
  (input: {
    readonly locator?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
  }) => {
    if ((input.x === undefined) !== (input.y === undefined)) return "x and y go together.";
    return (
      (input.locator === undefined) !== (input.x === undefined) || "Give a locator, or x and y."
    );
  },
);

const pointerTarget = {
  locator: Schema.optionalKey(BrowserLocator),
  x: Schema.optionalKey(Coordinate),
  y: Schema.optionalKey(Coordinate),
  timeoutMs: Schema.optionalKey(Timeout),
};

/**
 * One action on a page, as a page host runs it. `BrowserActInput` is the
 * same in the flat shape a tool's arguments take; decoding those arguments
 * with this schema checks the fields the chosen action needs.
 */
export const BrowserAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("click"),
    ...pointerTarget,
    button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
    clickCount: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }).check(exactlyOneTarget),
  Schema.Struct({
    action: Schema.Literal("type"),
    /** Without one, the text goes to the element that has focus, which must take text. */
    locator: Schema.optionalKey(BrowserLocator),
    text: Schema.String.check(Schema.isMaxLength(MAX_BROWSER_TYPE_LENGTH)),
    /** Replace what the field holds instead of adding to it. */
    clear: Schema.optionalKey(Schema.Boolean),
    timeoutMs: Schema.optionalKey(Timeout),
  }),
  Schema.Struct({ action: Schema.Literal("hover"), ...pointerTarget }).check(exactlyOneTarget),
  Schema.Struct({
    action: Schema.Literal("select"),
    locator: BrowserLocator,
    /** Options of one native `<select>`, by value or label. Empty clears it. */
    values: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
    timeoutMs: Schema.optionalKey(Timeout),
  }),
  Schema.Struct({
    action: Schema.Literal("drag"),
    source: BrowserLocator,
    target: BrowserLocator,
    timeoutMs: Schema.optionalKey(Timeout),
  }),
  Schema.Struct({
    action: Schema.Literal("upload"),
    /**
     * Files for the page: paths the host can read. The server turns a
     * bot's workspace paths into these before it asks the host.
     */
    paths: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(20)),
    /** The `<input type=file>` to set, or a label for one. */
    locator: BrowserLocator,
    timeoutMs: Schema.optionalKey(Timeout),
  }),
  Schema.Struct({
    action: Schema.Literal("press"),
    /** One key, as `KeyboardEvent.key` names it, such as `Enter`; sent to the element with focus. */
    key: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(64)),
    modifiers: Schema.optionalKey(Schema.Array(BrowserKeyModifier)),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    /** A container to scroll; without one, the page. */
    locator: Schema.optionalKey(BrowserLocator),
    deltaX: Schema.optionalKey(Coordinate),
    deltaY: Schema.optionalKey(Coordinate),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.deltaX !== undefined || input.deltaY !== undefined || "Give deltaX or deltaY.",
    ),
  ),
]);
export type BrowserAction = typeof BrowserAction.Type;

/** What a `select` action leaves selected: the values of the options now chosen. */
export const BrowserActOutcome = Schema.Struct({
  selected: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type BrowserActOutcome = typeof BrowserActOutcome.Type;

/**
 * What `browser_wait_for` waits for: every condition given at once. A
 * locator matching an element, text in the page, or the address holding a
 * piece.
 */
export const BrowserWaitCondition = Schema.Struct({
  locator: Schema.optionalKey(BrowserLocator),
  text: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))),
  urlIncludes: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))),
  timeoutMs: Schema.optionalKey(Timeout),
}).check(
  Schema.makeFilter(
    (input) =>
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined ||
      "Give at least one condition.",
  ),
);
export type BrowserWaitCondition = typeof BrowserWaitCondition.Type;

/** Where `navigate` goes: an address, or back, forward or a reload. */
export const BrowserNavigation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: BrowserAddress }),
  Schema.Struct({ kind: Schema.Literals(["back", "forward", "reload"]) }),
]);
export type BrowserNavigation = typeof BrowserNavigation.Type;

// ---------------------------------------------------------------------------
// What a page shows

/** Why the tab shows the browser's error page instead of the page it tried. */
export const BrowserLoadError = Schema.Struct({
  url: Schema.String,
  /** Chromium's net error, such as -105 for a name that did not resolve. */
  code: Schema.Int,
  description: Schema.String,
});
export type BrowserLoadError = typeof BrowserLoadError.Type;

/** A picture of the page, base64 in `data`, in device pixels. */
export const BrowserImage = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isBase64()),
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type BrowserImage = typeof BrowserImage.Type;

/** A tab's page as its host reports it. `url` never holds a `data:` payload. */
export const BrowserPageState = Schema.Struct({
  tab: BrowserTabRef,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  loadError: Schema.NullOr(BrowserLoadError),
  dialog: Schema.NullOr(BrowserDialog),
});
export type BrowserPageState = typeof BrowserPageState.Type;

/**
 * The page as a bot reads it: its accessibility tree, in which each element
 * a bot can act on carries `[ref=…]`. Refs work until the page changes or
 * the next snapshot. A password field's value, and any text the page hides
 * behind dots, shows as `••••••••`; a `data:` address keeps only its type.
 */
export const BrowserPageSnapshot = Schema.Struct({
  ...BrowserPageState.fields,
  tree: Schema.String.check(Schema.isMaxLength(MAX_BROWSER_SNAPSHOT_LENGTH)),
  /** The tree was longer, and was cut. */
  truncated: Schema.Boolean,
  /** With `includeImage`: the page as it looks, at most 1280 pixels wide. */
  image: Schema.optionalKey(BrowserImage),
});
export type BrowserPageSnapshot = typeof BrowserPageSnapshot.Type;

/** An evaluation's result: the expression's value, as JSON, or null. */
export const BrowserEvaluation = Schema.Struct({ value: Schema.Json });
export type BrowserEvaluation = typeof BrowserEvaluation.Type;

// ---------------------------------------------------------------------------
// The tools' arguments
//
// Every tool but `browser_tabs` and `browser_open` takes an optional `tab`.
// Without one, it works on the bot's current tab: the one it last opened or
// acted on, or, for a bot that has none, the tab the person looks at.

const tabField = { tab: Schema.optionalKey(BrowserTabRef) };

export const BrowserTabsInput = Schema.Struct({});
export type BrowserTabsInput = typeof BrowserTabsInput.Type;

export const BrowserOpenInput = Schema.Struct({
  /** Omit for a blank tab. */
  url: Schema.optionalKey(BrowserAddress),
  /** Open it without bringing it to the front where the person looks. */
  background: Schema.optionalKey(Schema.Boolean),
  readiness: Schema.optionalKey(BrowserReadiness),
  timeoutMs: Schema.optionalKey(Timeout),
});
export type BrowserOpenInput = typeof BrowserOpenInput.Type;

export const BrowserNavigateInput = Schema.Struct({
  ...tabField,
  url: Schema.optionalKey(BrowserAddress),
  /** Instead of `url`: go back, forward, or reload the page. */
  go: Schema.optionalKey(Schema.Literals(["back", "forward", "reload"])),
  readiness: Schema.optionalKey(BrowserReadiness),
  timeoutMs: Schema.optionalKey(Timeout),
}).check(
  Schema.makeFilter(
    (input) => (input.url === undefined) !== (input.go === undefined) || "Give url or go.",
  ),
);
export type BrowserNavigateInput = typeof BrowserNavigateInput.Type;

export const BrowserSnapshotInput = Schema.Struct({
  ...tabField,
  /** Also return a picture of the page. */
  includeImage: Schema.optionalKey(Schema.Boolean),
});
export type BrowserSnapshotInput = typeof BrowserSnapshotInput.Type;

/**
 * `browser_act`'s arguments: one flat shape for every action, as the
 * engine's own tool takes them. The bridge decodes the same arguments with
 * `BrowserAction` for the fields the action needs.
 */
export const BrowserActInput = Schema.Struct({
  ...tabField,
  action: Schema.Literals([
    "click",
    "type",
    "hover",
    "select",
    "drag",
    "upload",
    "press",
    "scroll",
  ]),
  locator: Schema.optionalKey(BrowserLocator),
  x: Schema.optionalKey(Coordinate),
  y: Schema.optionalKey(Coordinate),
  button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
  clickCount: Schema.optionalKey(Schema.Int),
  text: Schema.optionalKey(Schema.String),
  clear: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(Schema.Array(Schema.String)),
  source: Schema.optionalKey(BrowserLocator),
  target: Schema.optionalKey(BrowserLocator),
  /** Files in the bot's workspace. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  key: Schema.optionalKey(Schema.String),
  modifiers: Schema.optionalKey(Schema.Array(BrowserKeyModifier)),
  deltaX: Schema.optionalKey(Coordinate),
  deltaY: Schema.optionalKey(Coordinate),
  timeoutMs: Schema.optionalKey(Timeout),
});
export type BrowserActInput = typeof BrowserActInput.Type;

export const BrowserEvaluateInput = Schema.Struct({
  ...tabField,
  expression: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BROWSER_EXPRESSION_LENGTH),
  ),
  /** Wait for a promise the expression returns. Default true. */
  awaitPromise: Schema.optionalKey(Schema.Boolean),
});
export type BrowserEvaluateInput = typeof BrowserEvaluateInput.Type;

export const BrowserWaitForInput = Schema.Struct({
  ...tabField,
  ...BrowserWaitCondition.fields,
});
export type BrowserWaitForInput = typeof BrowserWaitForInput.Type;

export const BrowserDialogInput = Schema.Struct({
  ...tabField,
  accept: Schema.Boolean,
  /** The text to answer a prompt with. */
  promptText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_BROWSER_TYPE_LENGTH))),
});
export type BrowserDialogInput = typeof BrowserDialogInput.Type;

export const BrowserCloseInput = Schema.Struct(tabField);
export type BrowserCloseInput = typeof BrowserCloseInput.Type;

// ---------------------------------------------------------------------------
// The tools' results

/** A bot, as another bot reads it in a tool's result. */
export const BrowserBotName = Schema.Struct({ bot: BotId, name: Label });
export type BrowserBotName = typeof BrowserBotName.Type;

/**
 * A tab as `browser_tabs` lists it to a bot. A private tab is never listed.
 *
 * - `where`: `app` on the person's computer (`computer` names it), `server`,
 *   or `parked`, which the next use opens again on the server.
 * - `looking`: the tab the person has in front of them in the app now.
 * - `current`: this bot's current tab.
 * - `using`: who holds the tab now. A bot that is not this one, or the
 *   person, means this bot's actions there wait or fail; reading never does.
 */
export const BrowserToolTab = Schema.Struct({
  tab: BrowserTabRef,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  where: Schema.Literals(["app", "server", "parked"]),
  computer: Schema.optionalKey(Label),
  looking: Schema.Boolean,
  current: Schema.Boolean,
  openedBy: Schema.Union([Schema.Literals(["person", "page"]), BrowserBotName]),
  onIt: Schema.Array(BrowserBotName),
  using: Schema.Union([Schema.Literals(["nobody", "person", "server"]), BrowserBotName]),
  dialog: Schema.NullOr(BrowserDialog),
});
export type BrowserToolTab = typeof BrowserToolTab.Type;

/**
 * One short line the server adds to a result when something the bot did
 * not cause changed the tab: another bot acted on it, the person is using
 * it, or it moved between browsers.
 */
const noticeField = { notice: Schema.optionalKey(Schema.String) };

export const BrowserTabsResult = Schema.Struct({ tabs: Schema.Array(BrowserToolTab) });
export type BrowserTabsResult = typeof BrowserTabsResult.Type;

/** What `browser_open`, `browser_navigate` and `browser_dialog` return: the page now. */
export const BrowserTabResult = Schema.Struct({ ...BrowserPageState.fields, ...noticeField });
export type BrowserTabResult = typeof BrowserTabResult.Type;

export const BrowserSnapshotResult = Schema.Struct({
  ...BrowserPageSnapshot.fields,
  ...noticeField,
});
export type BrowserSnapshotResult = typeof BrowserSnapshotResult.Type;

export const BrowserActResult = Schema.Struct({ ...BrowserActOutcome.fields, ...noticeField });
export type BrowserActResult = typeof BrowserActResult.Type;

export const BrowserEvaluateResult = Schema.Struct({
  ...BrowserEvaluation.fields,
  ...noticeField,
});
export type BrowserEvaluateResult = typeof BrowserEvaluateResult.Type;

/** What `browser_wait_for` and `browser_close` return. */
export const BrowserDoneResult = Schema.Struct(noticeField);
export type BrowserDoneResult = typeof BrowserDoneResult.Type;
