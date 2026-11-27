// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { app } from "electron";
import { makeDesktopBrowser } from "../src/browser/host.ts";
import { linkToServer } from "../src/browser/link.ts";

// The desktop's browser alone, as the host check runs it: Electron on this
// file, with no window of the app, linked to the server the check plays at
// `J3_CHECK_SERVER`, its profile and scratch folder in `J3_CHECK_FOLDER`.

const server = process.env["J3_CHECK_SERVER"];
const folder = process.env["J3_CHECK_FOLDER"];
if (server === undefined || folder === undefined)
  throw new Error("The host check gave no server or folder.");
app.setPath("userData", `${folder}/profile`);
app.setPath("downloads", `${folder}/downloads`);
// The browser lives on with no window open.
app.on("window-all-closed", () => undefined);

const program = Effect.gen(function* () {
  const browser = yield* makeDesktopBrowser({ scratch: `${folder}/scratch` });
  yield* linkToServer({
    origin: server,
    token: Redacted.make("device-token-of-the-check"),
    host: browser.hostFor(DeviceId.make("device-check")),
    refused: Effect.succeed(false),
    onRefused: Effect.void,
  });
}).pipe(Effect.scoped);

void app.whenReady().then(() =>
  Effect.runPromise(
    program.pipe(
      Effect.tapCause(Effect.logError),
      Effect.onError(() => Effect.sync(() => app.exit(1))),
    ),
  ),
);
