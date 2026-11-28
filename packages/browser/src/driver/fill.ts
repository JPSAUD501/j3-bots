// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserFillField,
  type BrowserFillResult,
  BrowserHostError,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { CDPSession, Frame, Page } from "playwright-core";
import {
  emptyField,
  fieldGone,
  focusedLength,
  type FillInput,
  fillTarget,
  selectField,
  typedInto,
} from "./pageScripts.ts";

// Typing a saved login into a tab (`docs/architecture/server.md`, "Filling a
// login"). The server has checked the login and the page's origin, and holds
// the tab; this checks the page itself, beside it, right before it types:
// the page is still at the address the server checked, loaded, and its focus
// is on an input of its top frame that fits the value. The checks run in an
// isolated world of the top frame, which the page's script can neither see
// nor fool, and the element they found is the one checked again after
// typing. The value goes to the browser alone, through `Input.insertText`,
// and never into an error, a log or a result.

/** What a fill asks of the tab. */
export interface FillRequest {
  readonly field: BrowserFillField;
  readonly value: Redacted.Redacted<string>;
  /** The address the server checked the login's origins against. */
  readonly url: string;
  readonly submit: boolean;
}

/** How long a fill may take, apart from the wait for a submitted page to leave. */
const FILL_MS = 10_000;
/** After Enter on a password, how long the page has to leave before the field is cleared. */
const LEAVE_MS = 6_000;
const POLL_MS = 100;

const WORLD = "j3-fill";

const RemoteObject = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  objectId: Schema.optionalKey(Schema.String),
});
const decodeRemote = Schema.decodeUnknownOption(RemoteObject);
const Refusal = Schema.Literals(["field", "navigated", "loading"]);
const isRefusal = Schema.is(Refusal);
const isLength = Schema.is(Schema.Int);

/** A step of the fill failed; the detail never holds the value. */
const failed = (detail: string) => new BrowserHostError({ reason: "page", detail });

/**
 * The fill of one tab: `page`, driven over `cdp`, the page's own session.
 * `noDialog` refuses while a dialog waits; `dialogOpens` ends when the page
 * opens one, as a submit that alerts does.
 */
export const makeFill = (options: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly noDialog: Effect.Effect<void, BrowserHostError>;
  readonly dialogOpens: Effect.Effect<void>;
}) => {
  const { page, cdp, noDialog, dialogOpens } = options;

  /** A CDP call; its failure says only which step failed. */
  const send = <A>(step: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => failed(`The page did not answer ${step}.`) });

  /** Calls `fn` with the element `objectId`, in its world, and what it answers by value. */
  const onField = (
    step: string,
    objectId: string,
    fn: (field: FillInput, ...args: Array<never>) => unknown,
    args: ReadonlyArray<number>,
  ) =>
    send(step, () =>
      cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn.toString(),
        arguments: [{ objectId }, ...args.map((value) => ({ value }))],
        returnByValue: true,
      }),
    ).pipe(Effect.map(({ result }) => decodeRemote(result)));

  const answer = (read: Option.Option<typeof RemoteObject.Type>) =>
    Option.flatMap(read, (remote) => Option.fromUndefinedOr(remote.value));

  /** The isolated world of the top frame's document now. */
  const topWorld = Effect.gen(function* () {
    const { frameTree } = yield* send("for its frames", () => cdp.send("Page.getFrameTree"));
    const { executionContextId } = yield* send("for an isolated world", () =>
      cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD }),
    );
    return executionContextId;
  });

  /** The focused input the value may go into, or why there is none. */
  const target = Effect.fn("fill.target")(function* (request: FillRequest) {
    const contextId = yield* topWorld;
    const { result } = yield* send("for the focused field", () =>
      cdp.send("Runtime.callFunctionOn", {
        executionContextId: contextId,
        functionDeclaration: fillTarget.toString(),
        arguments: [{ value: request.field }, { value: request.url }],
        returnByValue: false,
      }),
    );
    const remote = decodeRemote(result);
    if (Option.isNone(remote)) return yield* failed("The page gave no answer about its focus.");
    const { value, objectId, subtype } = remote.value;
    if (isRefusal(value)) return { _tag: "refused", reason: value } as const;
    if (objectId === undefined || subtype !== "node")
      return yield* failed("The page gave no answer about its focus.");
    return { _tag: "field", objectId } as const;
  });

  /** Enter, to the focused field. A page that opens a dialog on it is left waiting on it. */
  const pressEnter = Effect.race(
    send("to Enter", () => page.keyboard.press("Enter")),
    dialogOpens,
  );

  /**
   * Whether the page left the field within `LEAVE_MS`: a new document in
   * the top frame, the tab closed, or the field gone or emptied by the page.
   */
  const leftField = Effect.fn("fill.leftField")(
    function* (objectId: string, navigated: () => boolean) {
      while (true) {
        if (navigated() || page.isClosed()) return true;
        const gone = yield* onField("about the field", objectId, fieldGone, []).pipe(
          // An object of a document that is gone cannot be called on.
          Effect.orElseSucceed(() => Option.some({ type: "boolean", value: true })),
          Effect.map(answer),
        );
        if (Option.getOrNull(gone) === true) return true;
        yield* Effect.sleep(POLL_MS);
      }
    },
    Effect.timeoutOption(LEAVE_MS),
    Effect.map(Option.getOrElse(() => false)),
  );

  /** Takes the password out of a field the page kept, with the key a person would use. */
  const clear = Effect.fn("fill.clear")(function* (objectId: string) {
    yield* onField("to select the field", objectId, selectField, []);
    yield* send("to Backspace", () => page.keyboard.press("Backspace"));
    const empty = answer(yield* onField("to empty the field", objectId, emptyField, []));
    if (Option.getOrNull(empty) !== true) return yield* failed("The field could not be emptied.");
  });

  const fill = Effect.fn("fill")(function* (request: FillRequest) {
    yield* noDialog;
    let navigated = false;
    const onNavigated = (frame: Frame) => {
      if (frame === page.mainFrame()) navigated = true;
    };
    page.on("framenavigated", onNavigated);
    yield* Effect.addFinalizer(() => Effect.sync(() => page.off("framenavigated", onNavigated)));

    const found = yield* target(request);
    if (found._tag === "refused") return found satisfies BrowserFillResult;
    const { objectId } = found;
    yield* Effect.addFinalizer(() =>
      // A document that is gone took the object with it.
      Effect.promise(() =>
        cdp.send("Runtime.releaseObject", { objectId }).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
    // Read last before the typing: a focus that moved since the check takes nothing.
    const length = answer(yield* onField("about the field", objectId, focusedLength, []));
    if (navigated) return { _tag: "refused", reason: "navigated" } as const;
    const before = Option.getOrNull(Option.filter(length, isLength));
    if (before === null) return { _tag: "refused", reason: "field" } as const;
    yield* send("to the typing", () =>
      cdp.send("Input.insertText", { text: Redacted.value(request.value) }),
    );
    const landed = answer(yield* onField("about the field", objectId, typedInto, [before]));
    if (Option.getOrNull(landed) !== true)
      return yield* failed("The focus moved while the value was typed.");
    const submitted = request.submit || request.field === "password";
    if (submitted) yield* pressEnter;
    if (request.field !== "password") return { _tag: "typed", submitted, cleared: false } as const;
    if (yield* leftField(objectId, () => navigated)) {
      return { _tag: "typed", submitted, cleared: false } as const;
    }
    yield* clear(objectId);
    return { _tag: "typed", submitted, cleared: true } as const;
  }, Effect.scoped);

  return (request: FillRequest): Effect.Effect<BrowserFillResult, BrowserHostError> =>
    fill(request).pipe(
      Effect.timeoutOption(FILL_MS + LEAVE_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new BrowserHostError({
                reason: "timeout",
                detail: "The fill did not finish in time; it may have typed. Look at the page.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
};
