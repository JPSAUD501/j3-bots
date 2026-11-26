// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorStatus, SECRET_NEED_REASONS, SecretName } from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ConnectorFailure } from "./errors.ts";

/**
 * A connector's status (`docs/architecture/server.md`, "Connectors"), from
 * what J3 Bots knows of it: whether its secrets can be read, whether it is
 * signed in, and how its server answered last. Only the secrets and the sign-in are
 * kept anywhere else; the rest is what this server saw since it started.
 */

/** Why the operator must sign in: never, the service ended it, or it refused what was given. */
export type SignInNeed = "not-signed-in" | "expired" | "rejected";

/** Why the server is failing, in J3 Bots' words: the contract's reasons. */
export type FailingReason =
  | "unreachable"
  | "timed-out"
  | "server-error"
  | "not-mcp"
  | "refused-address"
  | "command-not-found"
  | "command-exited"
  | "command-refused";

export interface Failing {
  readonly reason: FailingReason;
  /** The first failure since the last answer that worked. */
  readonly since: DateTime.Utc;
}

/** A secret the connector's settings name and cannot use, as its status says it. */
export interface SecretNeed {
  readonly secret: SecretName;
  readonly reason: (typeof SECRET_NEED_REASONS)[number];
}

export interface StatusInputs {
  readonly secretsUnavailable: boolean;
  /** None while every secret its settings name can be used, or it names none. */
  readonly secretNeed: Option.Option<SecretNeed>;
  /** None while it is signed in, or signs in no way at all. */
  readonly signIn: Option.Option<SignInNeed>;
  readonly failing: Option.Option<Failing>;
}

/**
 * The status the operator sees: secrets that cannot be read first, then a
 * secret its settings need, then a sign-in, then a failing server.
 */
export const statusOf = (inputs: StatusInputs): ConnectorStatus => {
  if (inputs.secretsUnavailable) return { _tag: "secrets-unavailable" };
  if (Option.isSome(inputs.secretNeed)) {
    return { _tag: "needs-secret", ...inputs.secretNeed.value };
  }
  if (Option.isSome(inputs.signIn)) return { _tag: "needs-sign-in", reason: inputs.signIn.value };
  if (Option.isSome(inputs.failing)) {
    return {
      _tag: "failing",
      reason: inputs.failing.value.reason,
      since: inputs.failing.value.since,
    };
  }
  return { _tag: "connected" };
};

/** What J3 Bots was doing when the server answered: a tool call's own trouble is the call's, not the connector's. */
export type Activity = "connect" | "call";

/** What an outcome changes in a connector's state. */
export type Observation =
  | { readonly _tag: "answered" }
  | { readonly _tag: "needs-sign-in"; readonly need: SignInNeed }
  | { readonly _tag: "failing"; readonly reason: FailingReason }
  | { readonly _tag: "unchanged" };

/**
 * What a failure says about the connector. Secrets that cannot be read, and
 * a secret its settings need, are their own status, which reaches the
 * connector from the secrets, and a withdrawn request says nothing of the
 * connector. A call that timed out,
 * answered too much, or got an MCP error is that call's trouble; the same
 * while connecting or listing means the server is not working.
 */
export const observe = (failure: ConnectorFailure, activity: Activity): Observation => {
  switch (failure._tag) {
    case "SecretsUnavailable":
    case "SecretNeeded":
    case "Withdrawn":
      return { _tag: "unchanged" };
    case "NeedsSignIn":
      return { _tag: "needs-sign-in", need: "rejected" };
    case "AuthFailing":
      return failure.reason === "secret-unusable"
        ? { _tag: "needs-sign-in", need: "rejected" }
        : { _tag: "failing", reason: "unreachable" };
    case "UrlRefused":
      return { _tag: "failing", reason: "refused-address" };
    case "Unreachable":
      return { _tag: "failing", reason: "unreachable" };
    case "NotMcp":
      return { _tag: "failing", reason: "not-mcp" };
    case "TimedOut":
      return activity === "connect"
        ? { _tag: "failing", reason: "timed-out" }
        : { _tag: "unchanged" };
    case "ServerError":
      return activity === "connect" || (failure.status !== null && failure.status >= 500)
        ? { _tag: "failing", reason: "server-error" }
        : { _tag: "unchanged" };
    case "ResponseTooLarge":
      return activity === "connect"
        ? { _tag: "failing", reason: "not-mcp" }
        : { _tag: "unchanged" };
    case "CommandFailed":
      return {
        _tag: "failing",
        reason:
          failure.reason === "not-found"
            ? "command-not-found"
            : failure.reason === "refused"
              ? "command-refused"
              : "command-exited",
      };
  }
};

/** The failing state after an observation at `now`: an answer clears it; a failure keeps the earliest `since`. */
export const nextFailing = (
  failing: Option.Option<Failing>,
  observation: Observation,
  now: DateTime.Utc,
): Option.Option<Failing> => {
  switch (observation._tag) {
    case "answered":
      return Option.none();
    case "failing":
      return Option.some({
        reason: observation.reason,
        since: Option.match(failing, { onNone: () => now, onSome: (f) => f.since }),
      });
    case "needs-sign-in":
    case "unchanged":
      return failing;
  }
};
