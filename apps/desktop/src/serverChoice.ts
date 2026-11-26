// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ConnectRefusal,
  ConnectResult,
  ForgetResult,
  LeftOut,
  LocalExportResult,
  ModeChange,
  ServerOrigin,
  UseThisComputerResult,
} from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ExportFailed } from "./localServer/exportProcess.ts";
import { parseServerAddress } from "./serverAddress.ts";
import { DesktopSettings } from "./settings.ts";

/** The page's storage could not be emptied. */
export class StorageNotCleared extends Schema.TaggedError<StorageNotCleared>()(
  "StorageNotCleared",
  { cause: Schema.Defect() },
) {}

/** The data of the bots on this computer could not be deleted. */
export class DataNotDeleted extends Schema.TaggedError<DataNotDeleted>()("DataNotDeleted", {
  cause: Schema.Defect(),
}) {}

/** The longest reason the page is given (`LocalExportResult`). */
const REASON_LIMIT = 4096;

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

/** Why the server on this computer could not be made ready. */
export type NotPrepared =
  /** Its home must be repaired first: why, and what repairs it, for the operator. */
  | { readonly _tag: "home-refused"; readonly reason: string; readonly fix: string }
  /** Anything else, to log. */
  | { readonly _tag: "failed"; readonly message: string };

/** The server this computer runs, as choosing where the bots live acts on it. */
export interface LocalServer {
  /** Whether this computer can run it. */
  readonly available: boolean;
  /**
   * Makes its home ready, the first time with ports chosen once, and answers
   * the origin the page reaches it at. Fails when the home cannot hold it.
   */
  readonly prepare: Effect.Effect<ServerOrigin, NotPrepared>;
  /** Starts it, and keeps it running. */
  readonly start: Effect.Effect<void>;
  /** Stops it, gracefully, its data kept. */
  readonly stop: Effect.Effect<void>;
  /** Writes the export of its data to `file`, while it is stopped; says what it left out. */
  readonly exportTo: (
    file: string,
    passphrase: Redacted.Redacted<string>,
  ) => Effect.Effect<LeftOut, ExportFailed>;
  /** Deletes its data from this computer, while it is stopped. */
  readonly deleteData: Effect.Effect<void, DataNotDeleted>;
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
   * signed in again once, without asking (`LocalDeviceRequest`). A home the
   * operator must repair first changes nothing, and is answered with why and
   * what repairs it.
   */
  const useThisComputer = Effect.fn("ServerChoice.useThisComputer")(function* (page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<UseThisComputerResult> {
        if (!local.available) return "unavailable";
        const prepared = yield* local.prepare.pipe(Effect.result);
        if (prepared._tag === "Failure") {
          const error = prepared.failure;
          if (error._tag === "home-refused") {
            return { _tag: "home-refused", reason: error.reason, fix: error.fix };
          }
          yield* Effect.logWarning("Preparing this computer's server failed", error.message);
          return "failed";
        }
        const server = prepared.success;
        const kept = yield* page.clearStorage.pipe(
          Effect.andThen(
            settings.update((current) => ({
              ...current,
              mode: "local",
              server,
              localDevice:
                current.localDevice === null ? null : { ...current.localDevice, current: false },
              // Bots that moved away and run here again are the operator's choice too.
              moved: null,
            })),
          ),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Choosing this computer failed", error).pipe(Effect.as(false)),
          ),
        );
        if (!kept) return "failed";
        yield* local.start;
        yield* page.openHome;
        return "changed";
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
   * Moves the bots on this computer to another server: stops their server,
   * writes the export of their data to `file`, its secrets sealed under
   * `passphrase`, and keeps that they moved (`moved`), so their server does
   * not start here again until the operator asks; then opens the first page,
   * which says so. An export that fails starts their server again.
   */
  const moveAway = Effect.fn("ServerChoice.moveAway")(function* (
    page: Page,
    file: string,
    passphrase: Redacted.Redacted<string>,
  ) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<LocalExportResult> {
        const current = yield* settings.get;
        if (current.mode !== "local" || current.moved !== null) return { _tag: "failed" };
        yield* local.stop;
        const exported = yield* Effect.result(local.exportTo(file, passphrase));
        if (Result.isFailure(exported)) {
          yield* Effect.logWarning(
            "Exporting this computer's bots failed",
            exported.failure.reason,
          );
          yield* local.start;
          const { reason } = exported.failure;
          return reason === undefined
            ? { _tag: "failed" }
            : { _tag: "failed", reason: reason.slice(0, REASON_LIMIT) };
        }
        const at = yield* DateTime.now;
        const kept = yield* settings
          .update((now) => ({ ...now, moved: { file, at, leftOut: exported.success } }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Keeping that this computer's bots moved failed", error).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (!kept) {
          // The next launch would start them again: they run here now too.
          yield* local.start;
          return {
            _tag: "failed",
            reason:
              `The export is written to ${file}, but the app could not keep that the bots moved, so they run on this computer again.`.slice(
                0,
                REASON_LIMIT,
              ),
          };
        }
        yield* page.openHome;
        return { _tag: "exported" };
      }),
    );
  });

  /** Runs the bots that moved away from this computer here again, on their data as it was kept. */
  const runHereAgain = Effect.fn("ServerChoice.runHereAgain")(function* (page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<ModeChange> {
        const current = yield* settings.get;
        if (current.mode !== "local" || current.moved === null) return "failed";
        const saved = yield* settings
          .update((now) => ({ ...now, moved: null }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Running this computer's bots again failed", error).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (!saved) return "failed";
        yield* local.start;
        yield* page.openHome;
        return "changed";
      }),
    );
  });

  /**
   * Deletes the data of the bots that moved away from this computer. In local
   * mode the app then asks again where the bots live, with the page's
   * storage emptied and the first page opened; elsewhere the page stays.
   */
  const deleteLocalData = Effect.fn("ServerChoice.deleteLocalData")(function* (page: Page) {
    return yield* oneAtATime.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<ModeChange> {
        const current = yield* settings.get;
        if (current.moved === null) return "failed";
        const deleted = yield* local.deleteData.pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Deleting this computer's bots' data failed", error).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (!deleted) return "failed";
        const wasLocal = current.mode === "local";
        const saved = yield* settings
          .update((now) => ({
            ...now,
            // The device this computer was signed in as went with the data.
            localDevice: null,
            moved: null,
            ...(wasLocal ? { mode: null, server: null, phoneAccess: false } : {}),
          }))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Forgetting this computer's bots failed", error).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (!saved) return "failed";
        if (wasLocal) {
          yield* page.clearStorage.pipe(
            Effect.catch((error) => Effect.logWarning("Clearing the page's storage failed", error)),
          );
          yield* page.openHome;
        }
        return "changed";
      }),
    );
  });

  /**
   * Runs `effect` while the bots run on this computer, one at a time with the
   * changes above: a change of where they run never comes between its steps.
   * Nothing, without running it, while they run elsewhere or moved away.
   */
  const whileLocal = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E, R> =>
    oneAtATime.withPermits(1)(
      settings.get.pipe(
        Effect.flatMap(({ mode, moved }) =>
          mode === "local" && moved === null ? Effect.asSome(effect) : Effect.succeedNone,
        ),
      ),
    );

  return {
    connect,
    forget,
    useThisComputer,
    connectToServerInstead,
    moveAway,
    runHereAgain,
    deleteLocalData,
    whileLocal,
  } as const;
});
