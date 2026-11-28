// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron's package answers its executable's path only to require().
import * as NodeModule from "node:module";
import { AppLinkUrl, BRIDGE_KEY, OpenResult, TokenProtection } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

// The development build as the desktop smoke and the every-surface check
// launch it: Electron's own executable on this app's folder, a fresh profile,
// and the page in English.

/** How long one step may take before a check fails, a cold Electron start included. */
export const STEP = 30_000;

export const electronPath = (): string => {
  const path: unknown = NodeModule.createRequire(import.meta.url)("electron");
  if (typeof path !== "string") throw new Error("The electron package gave no executable path.");
  return path;
};

// Linux CI runners do not allow the Chromium sandbox's user namespaces (as T3 Code's smoke).
// The page's language follows the system's; the steps read English.
export const ARGS = [`${import.meta.dirname}/..`, "--no-sandbox", "--lang=en-US"];

/**
 * A fresh profile: Electron keeps userData under XDG_CONFIG_HOME on Linux. The
 * app's handler of its links, a desktop entry and the default it names, is
 * kept under the same folder, away from the session running the check.
 */
export const environment = (profile: string) => ({
  ...process.env,
  XDG_CONFIG_HOME: profile,
  XDG_DATA_HOME: `${profile}/data`,
  LANGUAGE: "en_US",
  LC_ALL: "en_US.UTF-8",
});

/** The app on `profile`, started with `args` after the app's own, such as a link to the app. */
export const launch = (profile: string, args: ReadonlyArray<string> = []) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      _electron.launch({
        executablePath: electronPath(),
        args: [...ARGS, ...args],
        env: environment(profile),
        timeout: STEP,
      }),
    ),
    // A no-op once the check has closed it.
    (app: ElectronApplication) => Effect.promise(() => app.close()),
  );

/** The paths of the app's windows other than the main one. */
const OTHER_WINDOWS = new Set(["/quick", "/record", "/browser"]);

/**
 * The main window's page, once it has one. Not simply the first page: the
 * app's browser keeps pages of its own (its tabs and the probe of its
 * sign-ins), and quick access has a window of its own.
 */
export const mainWindow = (app: ElectronApplication) =>
  Effect.sync(() =>
    app.windows().find((page) => {
      const url = URL.parse(page.url());
      return url !== null && url.protocol === "j3bots-dev:" && !OTHER_WINDOWS.has(url.pathname);
    }),
  ).pipe(
    Effect.filterOrFail(
      (page): page is Page => page !== undefined,
      () => "not yet",
    ),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeout(STEP),
    Effect.orDie,
  );

/** A link to the development build, which takes `j3bots-dev:` links. */
export const linkTo = Schema.encodeSync(AppLinkUrl("j3bots-dev"));

/** The page's stored credential record, as JSON. */
export const storedCredential = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const opening = indexedDB.open("j3-bots");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const read = opening.result
            .transaction("credentials")
            .objectStore("credentials")
            .get("device");
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            opening.result.close();
            resolve(read.result);
          };
        };
      }),
  );

export const SealedRecord = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    server: Schema.String,
    sealed: Schema.String,
    protection: TokenProtection,
  }),
);

/** The device token `sealed` holds, opened through the page's bridge as the app opens it. */
export const openToken = (page: Page, sealed: string) =>
  Effect.promise(() =>
    page.evaluate(
      ({ key, sealed }) => {
        const bridge: unknown = Reflect.get(window, key);
        const open: unknown =
          typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "openToken") : null;
        return typeof open === "function" ? Promise.resolve(open(sealed)) : null;
      },
      { key: BRIDGE_KEY, sealed },
    ),
  ).pipe(
    Effect.map((answer) =>
      Schema.decodeUnknownOption(OpenResult)(answer).pipe(
        Option.flatMap((opened) =>
          opened._tag === "opened" ? Option.some(opened.token) : Option.none(),
        ),
      ),
    ),
  );
