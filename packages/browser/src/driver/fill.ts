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
import type { CDPSession, Page } from "playwright-core";
import { emptyField, fieldGone, type FillInput, typeLogin } from "./pageScripts.ts";

// Typing a saved login into a tab (`docs/architecture/server.md`, "Filling a
// login"). The server has checked the login and the page's origin, and holds
// the tab; this checks the page itself, beside it, right before it types:
// the page is still at the address the server checked, loaded, and its focus
// is on an input of its top frame that fits the value. The checks and the
// typing are one call into an isolated world of the top frame, which the
// page's script can neither see nor fool, and between which none of the
// page's script runs: the page cannot move the focus after the check. The
// value is that call's argument alone, typed through the top document's own
// editing, and never goes into an error, a log or a result.

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
const CallResult = Schema.Struct({ result: Schema.Unknown });
const decodeCall = Schema.decodeUnknownOption(CallResult);
const FrameTree = Schema.Struct({
  frameTree: Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) }),
});
const decodeFrameTree = Schema.decodeUnknownOption(FrameTree);
const IsolatedWorld = Schema.Struct({ executionContextId: Schema.Int });
const decodeIsolatedWorld = Schema.decodeUnknownOption(IsolatedWorld);
const Refusal = Schema.Literals(["field", "navigated", "loading"]);
const isRefusal = Schema.is(Refusal);

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

  /** A CDP answer, decoded; one in another shape fails as `step`'s. */
  const decoded = <A>(step: string, decode: (raw: unknown) => Option.Option<A>, raw: unknown) =>
    Effect.fromOption(decode(raw)).pipe(
      Effect.mapError(() => failed(`The page answered ${step} in another shape.`)),
    );

  /** What `Runtime.callFunctionOn` answered: the remote object, if it gave one. */
  const remoteOf = (raw: unknown) =>
    Option.flatMap(decodeCall(raw), ({ result }) => decodeRemote(result));

  /** Calls `fn` with the element `objectId`, in its world, and what it answers by value. */
  const onField = (step: string, objectId: string, fn: (field: FillInput) => unknown) =>
    send(step, () =>
      cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn.toString(),
        arguments: [{ objectId }],
        returnByValue: true,
      }),
    ).pipe(Effect.map(remoteOf));

  const answer = (read: Option.Option<typeof RemoteObject.Type>) =>
    Option.flatMap(read, (remote) => Option.fromUndefinedOr(remote.value));

  /** The isolated world of the top frame's document now. */
  const topWorld = Effect.gen(function* () {
    const { frameTree } = yield* send("for its frames", () => cdp.send("Page.getFrameTree")).pipe(
      Effect.flatMap((raw) => decoded("for its frames", decodeFrameTree, raw)),
    );
    const { executionContextId } = yield* send("for an isolated world", () =>
      cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD }),
    ).pipe(Effect.flatMap((raw) => decoded("for an isolated world", decodeIsolatedWorld, raw)));
    return executionContextId;
  });

  /**
   * Types the value into the focused field, in the one call that checks it
   * may (`typeLogin`): the field it went into, or why nothing was typed.
   */
  const type = Effect.fn("fill.type")(function* (request: FillRequest) {
    const contextId = yield* topWorld;
    const remote = yield* send("to the typing", () =>
      cdp.send("Runtime.callFunctionOn", {
        executionContextId: contextId,
        functionDeclaration: typeLogin.toString(),
        arguments: [
          { value: request.field },
          { value: request.url },
          { value: Redacted.value(request.value) },
        ],
        returnByValue: false,
      }),
    ).pipe(Effect.flatMap((raw) => decoded("to the typing", remoteOf, raw)));
    const { value, objectId, subtype } = remote;
    if (isRefusal(value)) return { _tag: "refused", reason: value } as const;
    if (value === "missed") return yield* failed("The value did not land in the field.");
    if (objectId === undefined || subtype !== "node")
      return yield* failed("The page gave no answer about its focus.");
    return { _tag: "typed", objectId } as const;
  });

  /** Enter, to the focused field. A page that opens a dialog on it is left waiting on it. */
  const pressEnter = Effect.race(
    send("to Enter", () => page.keyboard.press("Enter")),
    dialogOpens,
  );

  /**
   * Whether the page left the field within `LEAVE_MS`: a new document in
   * the top frame, the tab closed, or the field gone or emptied by the page.
   * A new address alone is not leaving: a page can change it in place, with
   * the form and the value still on it.
   */
  const leftField = Effect.fn("fill.leftField")(
    function* (objectId: string) {
      while (true) {
        if (page.isClosed()) return true;
        const gone = yield* onField("about the field", objectId, fieldGone).pipe(
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

  /** Takes the password out of a field the page kept. */
  const clear = Effect.fn("fill.clear")(function* (objectId: string) {
    const empty = answer(yield* onField("to empty the field", objectId, emptyField));
    if (Option.getOrNull(empty) !== true) return yield* failed("The field could not be emptied.");
  });

  const fill = Effect.fn("fill")(function* (request: FillRequest) {
    yield* noDialog;
    const typed = yield* type(request);
    if (typed._tag === "refused") return typed satisfies BrowserFillResult;
    const { objectId } = typed;
    yield* Effect.addFinalizer(() =>
      // A document that is gone took the object with it.
      Effect.promise(() =>
        cdp.send("Runtime.releaseObject", { objectId }).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
    const submitted = request.submit || request.field === "password";
    if (submitted) yield* pressEnter;
    if (request.field !== "password") return { _tag: "typed", submitted, cleared: false } as const;
    if (yield* leftField(objectId)) return { _tag: "typed", submitted, cleared: false } as const;
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
