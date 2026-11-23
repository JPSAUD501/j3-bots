// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  HarnessLocation,
  ProviderConnectionOutcome,
  ProviderConnectionRequest,
  ProviderSignInStatus,
  SignInHarness,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";

/**
 * Where a harness's sign-in stands, as this client follows it: as the server
 * reports it, `idle` before any, or `unsupported` when the server cannot run
 * one, as a server from before 0.3.0 answers.
 */
export type SignInView =
  | { readonly _tag: "idle" }
  | ProviderSignInStatus
  | { readonly _tag: "unsupported" };

/** What became of an endpoint connection; `failed` when the server gave no answer it could. */
export type ConnectEndpointResult = ProviderConnectionOutcome | { readonly _tag: "failed" };

const idle: SignInView = { _tag: "idle" };

/**
 * Setting the providers up from this client, for a desktop that runs the
 * server itself: the harnesses' own sign-ins and an endpoint connection
 * (`ProviderRpcs`).
 */
export class ProviderSetup extends Context.Service<
  ProviderSetup,
  {
    /** Each harness's sign-in, as this client follows it. */
    readonly signIns: Readable<ReadonlyMap<SignInHarness, SignInView>>;
    /**
     * Starts the harness's sign-in, or follows the one under way. On a new
     * socket it follows the same one again, and never starts another.
     * `openPage` opens the page it waits on, once, unless the harness opened
     * it itself.
     */
    readonly signIn: (
      harness: SignInHarness,
      openPage: (url: string) => void,
    ) => Effect.Effect<void>;
    /** Stops the harness's sign-in under way. */
    readonly cancelSignIn: (harness: SignInHarness) => Effect.Effect<void>;
    /** Where the server finds each harness; null when it cannot say. */
    readonly harnesses: Effect.Effect<ReadonlyArray<HarnessLocation> | null>;
    readonly connect: (request: ProviderConnectionRequest) => Effect.Effect<ConnectEndpointResult>;
  }
>()("@j3-bots/client-runtime/stores/ProviderSetup") {}

export const layer = Layer.effect(
  ProviderSetup,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;
    const signIns = new Cell<ReadonlyMap<SignInHarness, SignInView>>(new Map());
    const following = new Map<SignInHarness, Fiber.Fiber<void>>();
    const show = (harness: SignInHarness, view: SignInView) =>
      Effect.sync(() => signIns.update((current) => new Map(current).set(harness, view)));

    const follow = (harness: SignInHarness, openPage: (url: string) => void) => {
      // Only the first socket starts one: on the next, a sign-in that ended meanwhile is not run again.
      let start = true;
      let pageOpened = false;
      const open = (status: ProviderSignInStatus) =>
        Effect.sync(() => {
          if (status._tag !== "waiting-for-browser" || status.opened || pageOpened) return;
          pageOpened = true;
          openPage(status.url);
        });
      return connection
        .call((client) => {
          const first = start;
          start = false;
          return client["provider.signIn"]({ harness, start: first }).pipe(
            Stream.runForEach((status) => Effect.andThen(show(harness, status), open(status))),
          );
        })
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : // Not paired any more, or a server that answers this RPC with a defect.
                show(harness, Exit.hasDies(exit) ? { _tag: "unsupported" } : idle),
          ),
        );
    };

    const signIn = Effect.fn("ProviderSetup.signIn")(function* (
      harness: SignInHarness,
      openPage: (url: string) => void,
    ) {
      const current = following.get(harness);
      if (current !== undefined) yield* Fiber.interrupt(current);
      yield* show(harness, { _tag: "starting" });
      const fiber = yield* follow(harness, openPage).pipe(Effect.forkIn(scope));
      following.set(harness, fiber);
    });

    const cancelSignIn = Effect.fn("ProviderSetup.cancelSignIn")(function* (
      harness: SignInHarness,
    ) {
      yield* connection
        .call((client) => client["provider.cancelSignIn"]({ harness }))
        .pipe(Effect.ignore);
    });

    const harnesses = connection
      .call((client) => client["provider.harnesses"]())
      .pipe(
        Effect.orElseSucceed(() => null),
        Effect.catchDefect(() => Effect.succeed(null)),
      );

    const connect = (request: ProviderConnectionRequest) =>
      connection
        .call((client) => client["provider.connect"](request))
        .pipe(
          Effect.orElseSucceed((): ConnectEndpointResult => ({ _tag: "failed" })),
          Effect.catchDefect(() => Effect.succeed<ConnectEndpointResult>({ _tag: "failed" })),
        );

    return ProviderSetup.of({ signIns, signIn, cancelSignIn, harnesses, connect });
  }),
);
