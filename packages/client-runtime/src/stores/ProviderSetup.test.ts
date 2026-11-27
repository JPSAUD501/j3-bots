// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { ProviderId, type ProviderSignInStatus } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { firstAccountOf, followSignIn, type SignInAccount } from "./ProviderSetup.ts";

const dropped = new RpcClientError({
  reason: new RpcClientDefect({ message: "The socket closed", cause: null }),
});

const statuses: ReadonlyArray<ProviderSignInStatus> = [
  { _tag: "starting" },
  { _tag: "waiting-for-browser", url: "https://claude.com/cai/oauth/authorize", opened: false },
  { _tag: "succeeded", endpoint: null },
];

/**
 * A server's sign-ins, as `SignIns.follow` keeps them: a start while one is
 * under way follows it, and a request that does not start one follows the
 * one there is, or reports nothing.
 */
const server = () => {
  let underWay = false;
  const state = { harnessRuns: 0, asked: [] as Array<boolean> };
  const follow = (start: boolean) =>
    Effect.sync(() => {
      state.asked.push(start);
      if (start && !underWay) {
        underWay = true;
        state.harnessRuns++;
      }
      return underWay ? Stream.fromIterable(statuses) : Stream.empty;
    });
  return { state, follow };
};

/** How a socket ends each attempt: in order, one attempt each. */
type Attempt =
  /** The request never reached the server. */
  | "lost"
  /** The server took it, and the socket closed before any status came back. */
  | "taken"
  /** The first status came back, then the socket closed. */
  | "first-only"
  /** Everything came back. */
  | "whole";

/** What a socket that ends as `attempt` says brings back of a request to `follow`. */
const over = (
  attempt: Attempt,
  follow: ReturnType<typeof server>["follow"],
  start: boolean,
): Stream.Stream<ProviderSignInStatus, RpcClientError> => {
  switch (attempt) {
    case "lost":
      return Stream.fail(dropped);
    case "taken":
      return Stream.unwrap(Effect.as(follow(start), Stream.fail(dropped)));
    case "first-only":
      return Stream.unwrap(follow(start)).pipe(Stream.take(1), Stream.concat(Stream.fail(dropped)));
    case "whole":
      return Stream.unwrap(follow(start));
  }
};

/** Follows a sign-in over sockets that end as `attempts` say, as `Connection.call` runs again on the next. */
const followOver = (attempts: ReadonlyArray<Attempt>) =>
  Effect.gen(function* () {
    const { state, follow } = server();
    const shown: Array<ProviderSignInStatus["_tag"]> = [];
    const remaining = [...attempts];
    const seen = yield* followSignIn(
      (use) =>
        Effect.gen(function* () {
          while (true) {
            const attempt = remaining.shift();
            if (attempt === undefined) return yield* Effect.die("No socket is left");
            const exit = yield* Effect.exit(use(({ start }) => over(attempt, follow, start)));
            if (Exit.isSuccess(exit)) return;
          }
        }),
      firstAccountOf("claude-code"),
      (status) => Effect.sync(() => void shown.push(status._tag)),
    );
    return { ...state, shown, seen };
  });

it.effect("starts a sign-in whose first request was lost, and only one", () =>
  Effect.gen(function* () {
    const lost = yield* followOver(["lost", "whole"]);
    assert.deepStrictEqual(lost.asked, [true]);
    assert.strictEqual(lost.harnessRuns, 1);
    assert.deepStrictEqual(lost.shown.at(-1), "succeeded");

    // The server started it, and no status came back: asking again follows that one.
    const taken = yield* followOver(["taken", "whole"]);
    assert.deepStrictEqual(taken.asked, [true, true]);
    assert.strictEqual(taken.harnessRuns, 1);
    assert.deepStrictEqual(taken.shown.at(-1), "succeeded");
  }),
);

it.effect("only follows a sign-in once a status of it came back", () =>
  Effect.gen(function* () {
    const followed = yield* followOver(["first-only", "lost", "whole"]);
    assert.deepStrictEqual(followed.asked, [true, false]);
    assert.strictEqual(followed.harnessRuns, 1);
    assert.deepStrictEqual(followed.shown, [
      "starting",
      "starting",
      "waiting-for-browser",
      "succeeded",
    ]);
    assert.isTrue(followed.seen);
  }),
);

it.effect(
  "names an added account to the server, and the first of a harness by the harness alone",
  () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];
      const named = (account: SignInAccount) =>
        followSignIn(
          (use) =>
            use((payload) => {
              asked.push(payload);
              return Stream.fromIterable(statuses);
            }),
          account,
          () => Effect.void,
        );
      yield* named(firstAccountOf("codex"));
      yield* named({ harness: "codex", providerId: ProviderId.make("codex_work") });
      // A server older than added accounts takes the first's request as it always did.
      assert.deepStrictEqual(asked, [
        { harness: "codex", start: true },
        { harness: "codex", providerId: "codex_work", start: true },
      ]);
    }),
);
