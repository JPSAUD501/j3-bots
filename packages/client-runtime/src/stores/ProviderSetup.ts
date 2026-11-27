// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type HarnessLocation,
  type ProviderConnectionOutcome,
  type ProviderConnectionRequest,
  ProviderId,
  type ProviderSignInStatus,
  type SignInHarness,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { Connection } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";

/**
 * An AI account to sign in: one of `harness`'s, by its provider id. The
 * first of each harness has the harness's id, which every server has
 * (decision 0108).
 */
export interface SignInAccount {
  readonly harness: SignInHarness;
  readonly providerId: ProviderId;
}

/** The first account of `harness`: the one every server has, and the first run signs in. */
export const firstAccountOf = (harness: SignInHarness): SignInAccount => ({
  harness,
  providerId: ProviderId.make(harness),
});

/**
 * The account as `provider.signIn` names it: the first of a harness by the
 * harness alone, which every server takes; another by its id too, which only
 * a server that reports `ProviderStatus.setup`, and so has such accounts, does.
 */
const signInPayload = (account: SignInAccount) =>
  account.providerId === account.harness
    ? { harness: account.harness }
    : { harness: account.harness, providerId: account.providerId };

/**
 * Where an account's sign-in stands, as this client follows it: as the server
 * reports it, or `idle` before any.
 */
export type SignInView = { readonly _tag: "idle" } | ProviderSignInStatus;

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
    /** Each account's sign-in, as this client follows it, by provider id. */
    readonly signIns: Readable<ReadonlyMap<ProviderId, SignInView>>;
    /**
     * Starts the account's sign-in, or follows the one under way. On a new
     * socket it follows the same one again, and never starts another.
     * `openPage` opens the page it waits on, once, as soon as the server
     * has it: the operator never presses anything to see it.
     */
    readonly signIn: (account: SignInAccount, openPage: (url: string) => void) => Effect.Effect<void>;
    /** Stops the account's sign-in under way. */
    readonly cancelSignIn: (account: SignInAccount) => Effect.Effect<void>;
    /** Where the server finds each harness; null when it cannot say. */
    readonly harnesses: Effect.Effect<ReadonlyArray<HarnessLocation> | null>;
    readonly connect: (request: ProviderConnectionRequest) => Effect.Effect<ConnectEndpointResult>;
  }
>()("@j3-bots/client-runtime/stores/ProviderSetup") {}

/** A client's `provider.signIn`, as a sign-in is followed through it. */
type SignInCall = (payload: {
  readonly harness: SignInHarness;
  readonly providerId?: ProviderId;
  readonly start: boolean;
}) => Stream.Stream<ProviderSignInStatus, RpcClientError>;

/**
 * Follows `account`'s sign-in through `call`, which runs `use` again on each
 * new socket until it finishes (`Connection.call`), passing on each status.
 * Each attempt asks the server to start one until a first status has
 * arrived: a request lost on a socket that dropped started nothing, and the
 * server folds a second start into the sign-in under way. From then on it
 * only follows, so a sign-in that ended meanwhile is not run again. Says
 * whether any status arrived.
 */
export const followSignIn = <E>(
  call: (
    use: (signIn: SignInCall) => Effect.Effect<void, RpcClientError>,
  ) => Effect.Effect<void, E>,
  account: SignInAccount,
  onStatus: (status: ProviderSignInStatus) => Effect.Effect<void>,
): Effect.Effect<boolean, E> => {
  let seen = false;
  return call((signIn) =>
    signIn({ ...signInPayload(account), start: !seen }).pipe(
      Stream.runForEach((status) =>
        Effect.andThen(
          Effect.sync(() => {
            seen = true;
          }),
          onStatus(status),
        ),
      ),
    ),
  ).pipe(Effect.map(() => seen));
};

export const layer = Layer.effect(
  ProviderSetup,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;
    const signIns = new Cell<ReadonlyMap<ProviderId, SignInView>>(new Map());
    const following = new Map<ProviderId, Fiber.Fiber<void>>();
    const show = (account: SignInAccount, view: SignInView) =>
      Effect.sync(() =>
        signIns.update((current) => new Map(current).set(account.providerId, view)),
      );

    const follow = (account: SignInAccount, openPage: (url: string) => void) => {
      let pageOpened = false;
      const onStatus = (status: ProviderSignInStatus) =>
        Effect.andThen(
          show(account, status),
          Effect.sync(() => {
            if (status._tag !== "waiting-for-browser" || pageOpened) return;
            pageOpened = true;
            openPage(status.url);
          }),
        );
      return followSignIn(
        (use) => connection.call((client) => use(client["provider.signIn"])),
        account,
        onStatus,
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          // Not paired any more, or the call failed: no sign-in is under way.
          if (Exit.isFailure(exit)) return show(account, idle);
          // A server that reported nothing has no sign-in under way.
          return exit.value ? Effect.void : show(account, idle);
        }),
      );
    };

    const signIn = Effect.fn("ProviderSetup.signIn")(function* (
      account: SignInAccount,
      openPage: (url: string) => void,
    ) {
      const current = following.get(account.providerId);
      if (current !== undefined) yield* Fiber.interrupt(current);
      yield* show(account, { _tag: "starting" });
      const fiber = yield* follow(account, openPage).pipe(Effect.forkIn(scope));
      following.set(account.providerId, fiber);
    });

    const cancelSignIn = Effect.fn("ProviderSetup.cancelSignIn")(function* (
      account: SignInAccount,
    ) {
      yield* connection
        .call((client) => client["provider.cancelSignIn"](signInPayload(account)))
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
