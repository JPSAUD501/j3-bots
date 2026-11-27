// SPDX-License-Identifier: AGPL-3.0-or-later
import { readProfileSignIns } from "@j3-bots/browser";
import type { BrowserCookie } from "@j3-bots/contracts";
import { oldEngineBrowser, removeOldEngineBrowser } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerConfig } from "../../config.ts";
import { HOME_ENTRIES } from "../../home/entries.ts";
import type { JarOrigin } from "./merge.ts";
import { SignIns } from "./SignIns.ts";

// The one move of the sign-ins the bots made in the engine's browser, before
// J3 Bots ran its own (decision 0110; `docs/operations/operating.md`,
// "Updating to 0.16"). At start, in the background: each profile of the
// engine's browser is read by the browser that wrote it, what it holds goes
// into the shared sign-ins, and the engine's browser is removed. A profile
// that cannot be read now is tried again at the next start; nothing is
// removed before its sign-ins are in.

export const bringInOld = Effect.fn("SignIns.bringInOld")(function* (engineHome: string) {
  const signIns = yield* SignIns;
  const state = yield* signIns.toBringIn;
  if (state === "unavailable") return;
  const old = yield* oldEngineBrowser(engineHome);
  if (state === "due") {
    const cookies: Array<BrowserCookie> = [];
    const origins: Array<JarOrigin> = [];
    if (old.profiles.length > 0) {
      if (Option.isNone(old.executable)) {
        return yield* Effect.logWarning(
          "The engine's browser is gone, so its sign-ins cannot be read; they are tried again at the next start",
        );
      }
      for (const profile of old.profiles) {
        const read = yield* readProfileSignIns({
          profile,
          executablePath: old.executable.value,
        }).pipe(Effect.option);
        if (Option.isNone(read))
          return yield* Effect.logWarning(
            "The engine's browser's sign-ins could not be read; they are tried again at the next start",
          );
        cookies.push(...read.value.cookies);
        origins.push(...read.value.origins);
      }
    }
    yield* signIns.bringIn({ cookies, origins });
    yield* Effect.logInfo("The engine's browser's sign-ins were moved into J3 Bots' browser").pipe(
      Effect.annotateLogs({ cookies: cookies.length, origins: origins.length }),
    );
  }
  if (old.profiles.length > 0 || Option.isSome(old.executable))
    yield* removeOldEngineBrowser(engineHome);
});

/** Moves the engine's browser's sign-ins in, once, in the background of the server's start. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const path = yield* Path.Path;
    yield* bringInOld(path.join(home, HOME_ENTRIES.engine)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Moving the engine's browser's sign-ins failed").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
