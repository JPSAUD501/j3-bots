// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserInput } from "@j3-bots/contracts";
import { PreviewStreamHostSetup, type PreviewSessionSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { EngineBrowserTab, TabPage, ViewerOutput } from "../Browser.ts";
import { ViewerClosed } from "../Browser.ts";
import { EngineTabId, SessionId } from "../ids.ts";

// The engine's preview stream, `/api/preview-stream/ws`, as J3 Bots reads and
// writes it. Its JSON frames are untyped on the engine's side, so every frame
// is decoded here, and one this file does not know, or that does not decode,
// is dropped. **Read** at `bc0f04d`, `apps/server/src/preview/ServerBrowser.ts`
// (`ServerBrowserViewerOutput`, `dispatchViewerInput`, `attachViewer`) and
// `ServerBrowserStream.ts`. Among the frames dropped are `selectMenu` and
// `selectMenuClosed`: the engine keeps a native `<select>` from opening its
// own menu under a viewer's press and offers the viewer the options instead,
// to be answered with a `selectMenu` input, which this file does not send.

/** The stream's route. */
export const PREVIEW_STREAM_PATH = "/api/preview-stream/ws";

/** Close codes of the stream. **Read**, `ServerBrowserStream.ts` L31, L172-177. */
const TAB_GONE = 4404;
const HOST_SETUP = 4503;
const RECONNECT = 1012;

const Dimension = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The frames J3 Bots passes on; the clipboard, files and downloads are not
 * among them. The engine sends `pointer` only while the agent acts (**Read**,
 * `ServerBrowser.ts` L2433-2444).
 */
const StreamFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("viewport"), width: Dimension, height: Dimension }),
  Schema.Struct({
    type: Schema.Literal("control"),
    controller: Schema.Literals(["agent", "you", "another-viewer", "unclaimed"]),
    generation: Dimension,
    dialog: Schema.NullOr(
      Schema.Struct({
        type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
        message: Schema.String,
        defaultValue: Schema.String,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("probe"),
    x: Schema.Finite,
    y: Schema.Finite,
    editable: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
]);

const decodeStreamFrame = Schema.decodeUnknownOption(Schema.fromJsonString(StreamFrame));

const CONTROLLERS = {
  agent: "bot",
  you: "this-viewer",
  "another-viewer": "another-viewer",
  unclaimed: "nobody",
} as const;

/** A text frame of the stream, decoded, or none for one J3 Bots drops. */
export const decodeTextFrame = (text: string): Option.Option<ViewerOutput> =>
  Option.map(decodeStreamFrame(text), (frame): ViewerOutput => {
    switch (frame.type) {
      case "viewport":
        return { _tag: "viewport", width: frame.width, height: frame.height };
      case "control":
        return {
          _tag: "control",
          controller: CONTROLLERS[frame.controller],
          generation: frame.generation,
          dialog:
            frame.dialog === null
              ? null
              : {
                  kind: frame.dialog.type,
                  message: frame.dialog.message,
                  defaultValue: frame.dialog.defaultValue,
                },
        };
      case "probe":
        return { _tag: "probe", x: frame.x, y: frame.y, editable: frame.editable };
      case "pointer":
        return { _tag: "cursor", action: frame.phase, x: frame.x, y: frame.y };
    }
  });

const decodeHostSetup = Schema.decodeUnknownOption(Schema.fromJsonString(PreviewStreamHostSetup));

/** Why the stream closed, from its close code and reason. */
export const closeOf = (code: number, reason: string | undefined): ViewerClosed => {
  switch (code) {
    case TAB_GONE:
      return new ViewerClosed({ reason: "gone" });
    case HOST_SETUP: {
      const setup = decodeHostSetup(reason ?? "");
      return Option.isSome(setup)
        ? new ViewerClosed({ reason: "setup-needed", need: setup.value.need })
        : new ViewerClosed({ reason: "lost" });
    }
    case RECONNECT:
      return new ViewerClosed({ reason: "reconnect" });
    default:
      return new ViewerClosed({ reason: "lost" });
  }
};

/** The stream's message for one piece of input. **Read**, `dispatchViewerInput` and `attachViewer`'s `input`. */
export const encodeInput = (input: BrowserInput): string => {
  switch (input.type) {
    case "take":
      return JSON.stringify({ type: "takeControl" });
    case "release":
      return JSON.stringify({ type: "releaseControl" });
    case "pointer":
      return JSON.stringify({
        type: "mouse",
        action: input.action,
        x: input.x,
        y: input.y,
        button: input.button,
        buttons: input.buttons,
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      });
    case "back":
      return JSON.stringify({ type: "history", delta: -1 });
    case "forward":
      return JSON.stringify({ type: "history", delta: 1 });
    case "wheel":
    case "key":
    case "text":
    case "navigate":
    case "reload":
    case "probe":
    case "dialog":
      return JSON.stringify(input);
  }
};

/** The acknowledgement of the frame in flight. */
export const ACK = JSON.stringify({ type: "ack" });

// ---------------------------------------------------------------------------
// Tabs

const TabKey = Schema.Tuple([Schema.String, Schema.String]);
const decodeTabKey = Schema.decodeUnknownOption(Schema.fromJsonString(TabKey));

/** The id J3 Bots holds for the engine's tab `tabId` of thread `threadId`. */
const tabIdOf = (threadId: string, tabId: string): EngineTabId =>
  EngineTabId.make(JSON.stringify([threadId, tabId]));

/** The thread and tab an id names, or none for an id this package did not make. */
export const tabKeyOf = (id: EngineTabId) =>
  Option.map(decodeTabKey(id), ([threadId, tabId]) => ({ threadId, tabId }));

/**
 * The tab a snapshot describes, if a bot opened it in the engine's own
 * browser: a tab with an automation owner, which is the agent session that
 * opened it or opened the page whose pop-up it is (**Read**,
 * `ServerBrowser.ts`, `adoptPopup` and `openTab`). A person's tab, which a
 * viewer that may act would take on sight, is never listed.
 */
export const tabOf = (
  snapshot: PreviewSessionSnapshot,
  activeAt: number,
): Option.Option<EngineBrowserTab> => {
  if (snapshot.automationOwner === undefined || snapshot.runtime !== "server") {
    return Option.none();
  }
  const status = snapshot.navStatus;
  return Option.some({
    id: tabIdOf(snapshot.threadId, snapshot.tabId),
    sessionId: SessionId.make(snapshot.threadId),
    url: status._tag === "Idle" ? "" : status.url,
    title: status._tag === "Idle" ? "" : status.title,
    loading: status._tag === "Loading",
    activeAt,
  });
};

/**
 * The page a snapshot says its tab shows. **Read** at `bc0f04d`,
 * `contracts/src/preview.ts` (`PreviewNavStatus`): `Success` carries the
 * address the tab committed to; `Loading`, the one it is loading.
 */
export const pageOf = (snapshot: PreviewSessionSnapshot): TabPage => {
  const status = snapshot.navStatus;
  switch (status._tag) {
    case "Idle":
      return { _tag: "blank" };
    case "Loading":
      return { _tag: "loading", url: status.url };
    case "Success":
      return { _tag: "loaded", url: status.url };
    case "LoadFailed":
      return { _tag: "failed", url: status.url };
  }
};

/** An engine timestamp in epoch milliseconds, or 0 when it does not parse. */
export const millisOf = (timestamp: string) =>
  Option.match(DateTime.make(timestamp), { onNone: () => 0, onSome: DateTime.toEpochMillis });
