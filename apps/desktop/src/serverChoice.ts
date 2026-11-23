// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ConnectRefusal,
  ConnectResult,
  ForgetResult,
  ModeChange,
  ServerOrigin,
} from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parseServerAddress } from "./serverAddress.ts";
import { DesktopSettings } from "./settings.ts";

/** The page's storage could not be emptied. */
export class StorageNotCleared extends Schema.TaggedError<StorageNotCleared>()(
  "StorageNotCleared",
  { cause: Schema.Defect() },
) {}

/** The page that asks to connect or to forget the server. */
export interface Page {
  /** Empties the storage where the page keeps what belongs to a server: the credential, drafts, unsent messages. */
  readonly clearStorage: Effect.Effect<void, StorageNotCleared>;
  /**
   * Loads the app's first page, not the page again: a path such as a bot's
   * id belongs to the server just forgotten.
   */
  readonly openHome: Effect.Effect<void>;
}

/** The server this computer runs, as choosing where the bots live acts on it. */
export interface LocalServer {
  /** Whether this computer can run it. */
  readonly available: boolean;
  /**
   * Makes its home ready, the first time with ports chosen once, and answers
   * the origin the page reaches it at. Fails, with a message to log, when
   * the home cannot hold it.
   */
  readonly prepare: Effect.Effect<ServerOrigin, { readonly message: string }>;
  /** Starts it, and keeps it running. */
  readonly start: Effect.Effect<void>;
  /** Stops it, gracefully, its data kept. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Naming the server, running the bots on this computer, and forgetting the
 * server, one at a time, so a check that ends late never overwrites a newer
 * choice.
 *
 * A device token must never reach a server other than the one that issued
 * it. The page keeps it in its storage, which it fills only while a server is
 * kept. So the storage is emptied right before a server is kept, whatever the
 * settings file said before: nothing in it can belong to the new server. And
 * a server counts as kept only once it is written, so the page never runs on
 * a server the app would not find on its next launch.
 */
export const make = Effect.fn("ServerChoice.make")(function* (
  check: (origin: ServerOrigin) => Effect.Effect<ConnectRefusal | null>,
  local: LocalServer,
) {
  const settings = yield* DesktopSettings;
  const oneAtATime = yield* Semaphore.make(1);
  const refused = (reason: ConnectRefusal): ConnectResult => ({ _tag: "refused", reason });

  const connect = Effect.fn("ServerChoice.connect")(function* (address: string, page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        // A page that runs on a server forgets it first.
        if ((yield* settings.get).server !== null) return refused("server-kept");
        const parsed = parseServerAddress(address);
        if (Result.isFailure(parsed)) return refused(parsed.failure);
        const server = parsed.success;
        const refusal = yield* check(server);
        if (refusal !== null) return refused(refusal);
        return yield* page.clearStorage.pipe(
          Effect.andThen(settings.update((current) => ({ ...current, mode: "remote", server }))),
          Effect.as<ConnectResult>({ _tag: "connected", server }),
          Effect.catch((error) =>
            Effect.logWarning("Keeping the server failed", error).pipe(
              Effect.as(refused("not-saved")),
            ),
          ),
        );
      }),
    );
  });

  const forget = Effect.fn("ServerChoice.forget")(function* (page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        // The server on this computer is not forgotten by signing out of it:
        // that stops the bots, which only `connectToServerInstead` does.
        if ((yield* settings.get).mode === "local") return "failed" satisfies ForgetResult;
        const saved = yield* settings
          .update((current) => ({ ...current, server: null }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Forgetting the server failed", error).pipe(Effect.as(false)),
            ),
          );
        if (!saved) return "failed" satisfies ForgetResult;
        // What stays is cleared again before the next server is kept.
        yield* page.clearStorage.pipe(
          Effect.catch((error) => Effect.logWarning("Clearing the page's storage failed", error)),
        );
        yield* page.openHome;
        return "forgotten" satisfies ForgetResult;
      }),
    );
  });

  /**
   * Runs the bots on this computer: forgets any server named before, with
   * the page's storage, keeps the server on this computer as the page's, and
   * starts it. The device this computer was signed in as before, if any, is
   * signed in again once, without asking (`LocalDeviceRequest`).
   */
  const useThisComputer = Effect.fn("ServerChoice.useThisComputer")(function* (page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        if (!local.available) return "unavailable" satisfies ModeChange;
        const prepared = yield* local.prepare.pipe(
          Effect.map((server) => ({ _tag: "prepared" as const, server })),
          Effect.catch((error) =>
            Effect.logWarning("Preparing this computer's server failed", error.message).pipe(
              Effect.as({ _tag: "not-prepared" as const }),
            ),
          ),
        );
        if (prepared._tag === "not-prepared") return "failed" satisfies ModeChange;
        const { server } = prepared;
        const kept = yield* page.clearStorage.pipe(
          Effect.andThen(
            settings.update((current) => ({
              ...current,
              mode: "local",
              server,
              localDevice:
                current.localDevice === null ? null : { ...current.localDevice, current: false },
            })),
          ),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Choosing this computer failed", error).pipe(Effect.as(false)),
          ),
        );
        if (!kept) return "failed" satisfies ModeChange;
        yield* local.start;
        yield* page.openHome;
        return "changed" satisfies ModeChange;
      }),
    );
  });

  /**
   * Stops running the bots on this computer, their data kept, turns phone
   * access off, and opens the server address screen. The page signs its
   * device out first, while the server still runs; a device it could not is
   * revoked by the next sign-in on this computer, which replaces it.
   */
  const connectToServerInstead = Effect.fn("ServerChoice.connectToServerInstead")(function* (
    page: Page,
  ) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* settings.get).mode !== "local") return "failed" satisfies ModeChange;
        const saved = yield* settings
          .update((current) => ({
            ...current,
            mode: "remote",
            server: null,
            localDevice:
              current.localDevice === null ? null : { ...current.localDevice, current: false },
            // Coming back to this computer later starts its server on this
            // computer alone, not on whatever network it is on by then.
            phoneAccess: false,
          }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Leaving this computer's server failed", error).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (!saved) return "failed" satisfies ModeChange;
        yield* local.stop;
        yield* page.clearStorage.pipe(
          Effect.catch((error) => Effect.logWarning("Clearing the page's storage failed", error)),
        );
        yield* page.openHome;
        return "changed" satisfies ModeChange;
      }),
    );
  });

  /**
   * Runs `effect` while the bots run on this computer, one at a time with the
   * changes above: a change of where they run never comes between its steps.
   */
  const whileLocal = <E, R>(effect: Effect.Effect<void, E, R>) =>
    oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* settings.get).mode === "local") yield* effect;
      }),
    );

  return { connect, forget, useThisComputer, connectToServerInstead, whileLocal } as const;
});
