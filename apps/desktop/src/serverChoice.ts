// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ConnectRefusal,
  ConnectResult,
  ForgetResult,
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

/**
 * Naming the server and forgetting it, one at a time, so a check that ends
 * late never overwrites a newer choice.
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

  return { connect, forget } as const;
});
