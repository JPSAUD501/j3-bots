// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type HarnessLocation,
  ProviderId,
  type ProviderSignInStatus,
  SignInHarness,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import { findHarness, HARNESSES } from "../engine/harnesses.ts";
import { Host } from "../system/Host.ts";
import { prepareHome, SignInFailed, signIn } from "./signIn.ts";

/** Whether a sign-in has ended: nothing follows these. */
const signInEnded = (status: ProviderSignInStatus): boolean =>
  status._tag === "succeeded" || status._tag === "failed" || status._tag === "cancelled";

interface Running {
  readonly status: SubscriptionRef.SubscriptionRef<ProviderSignInStatus>;
  readonly fiber: Fiber.Fiber<void>;
}

/**
 * The sign-ins clients start (`provider.signIn`): each harness's own, run by
 * the server with no terminal for J3 Bots' home for it, as
 * `j3-bots provider login` runs it in one. At most one per harness at a time,
 * which every client that asks follows. A sign-in belongs to the server, not
 * to the socket that started it: it keeps running when that socket closes,
 * so a window that reconnects follows it again, until it ends, is cancelled
 * or times out.
 */
export class SignIns extends Context.Service<
  SignIns,
  {
    /** Where the server finds each harness, on the `PATH` it runs them with, looked up now. */
    readonly locations: Effect.Effect<ReadonlyArray<HarnessLocation>>;
    /**
     * The harness's sign-in under way, or with `start` a new one, else the
     * last one's ending: where it stands, then each change, ending with the
     * change that ends it. Nothing when none ran and `start` is false.
     */
    readonly follow: (
      harness: SignInHarness,
      start: boolean,
    ) => Stream.Stream<ProviderSignInStatus>;
    /** Stops the harness's sign-in under way, if any, and waits until it stopped. */
    readonly cancel: (harness: SignInHarness) => Effect.Effect<void>;
  }
>()("@j3-bots/server/providers/SignIns") {}

export const layer = Layer.effect(
  SignIns,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const host = yield* Host;
    const engine = yield* Engine;
    const context = yield* Effect.context<
      Host | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    const scope = yield* Effect.scope;
    // Each harness's latest sign-in, under way or ended.
    const latest = new Map<SignInHarness, Running>();
    const lock = yield* Semaphore.make(1);

    /**
     * One sign-in, from finding the harness to having the engine check it
     * again: the engine's own check comes minutes later otherwise.
     */
    const run = Effect.fn("SignIns.run")(function* (
      harness: SignInHarness,
      report: (status: ProviderSignInStatus) => Effect.Effect<void>,
    ) {
      const facts = HARNESSES[harness];
      const found = yield* findHarness(harness, Option.none(), config.home);
      if (Option.isNone(found.executable)) {
        return yield* new SignInFailed({
          reason: "not-installed",
          message: `${facts.executable} is not on the server's PATH, and J3 Bots installed no copy of it`,
        });
      }
      const home = yield* prepareHome(harness, config.home);
      yield* signIn({
        harness,
        executable: found.executable.value,
        home,
        environment: { ...(yield* Effect.sync(() => process.env)), PATH: found.searchPath },
        deviceAuth: false,
        platform: host.platform,
        io: { _tag: "app", report },
      });
      yield* engine
        .recheckProvider(ProviderId.make(harness))
        .pipe(
          Effect.catch((error) =>
            Effect.logInfo("The engine could not check a provider again after its sign-in", error),
          ),
        );
      return yield* engine.connectedEndpoint;
    });

    const start = Effect.fnUntraced(function* (harness: SignInHarness) {
      const status = yield* SubscriptionRef.make<ProviderSignInStatus>({ _tag: "starting" });
      const report = (next: ProviderSignInStatus) => SubscriptionRef.set(status, next);
      yield* Effect.logInfo("A provider sign-in started").pipe(Effect.annotateLogs({ harness }));
      const fiber = yield* run(harness, report).pipe(
        Effect.matchEffect({
          onSuccess: (endpoint) => report({ _tag: "succeeded", endpoint }),
          // What the harness printed is never logged: only why it ended.
          onFailure: (error) =>
            Effect.logInfo("A provider sign-in ended without signing in", error.message).pipe(
              Effect.annotateLogs({ harness, reason: error.reason }),
              Effect.andThen(report({ _tag: "failed", reason: error.reason })),
            ),
        }),
        Effect.onInterrupt(() => report({ _tag: "cancelled" })),
        Effect.provideContext(context),
        Effect.forkIn(scope),
      );
      const entry = { status, fiber };
      latest.set(harness, entry);
      return entry;
    });

    const follow = (harness: SignInHarness, startOne: boolean) =>
      Stream.unwrap(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = latest.get(harness);
            const underWay =
              current !== undefined && !signInEnded(yield* SubscriptionRef.get(current.status));
            const entry =
              underWay || (!startOne && current !== undefined)
                ? current
                : startOne
                  ? yield* start(harness)
                  : undefined;
            return entry === undefined
              ? Stream.empty
              : SubscriptionRef.changes(entry.status).pipe(Stream.takeUntil(signInEnded));
          }),
        ),
      );

    const cancel = Effect.fn("SignIns.cancel")(function* (harness: SignInHarness) {
      const current = yield* lock.withPermits(1)(Effect.sync(() => latest.get(harness)));
      if (current !== undefined) yield* Fiber.interrupt(current.fiber);
    });

    const locations = Effect.forEach(SignInHarness.literals, (harness) =>
      findHarness(harness, Option.none(), config.home).pipe(
        Effect.map(({ executable }): HarnessLocation => ({
          harness,
          path: Option.getOrNull(executable),
        })),
      ),
    ).pipe(Effect.provideContext(context));

    return SignIns.of({ locations, follow, cancel });
  }),
);
