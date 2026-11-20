// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Connection } from "../connection/Connection.ts";
import { Conversations } from "../stores/Conversations.ts";
import { Devices } from "../stores/Devices.ts";
import { Drafts } from "../stores/Drafts.ts";

/** How long signing out waits for the server to revoke this device before it goes on without. */
const REVOKE_WAIT = Duration.seconds(10);

/** What signing out did. */
export type SignOutResult =
  /** The server revoked this device, and nothing of it is left here. */
  | "signed-out"
  /** Nothing of it is left here, but the server was out of reach and still lists it. */
  | "still-listed"
  /** What it keeps here could not all be deleted, so it is still signed in. */
  | "failed";

/** Ends this device's access: on the server when it can be reached, and here in any case. */
export class SignOut extends Context.Service<
  SignOut,
  {
    /**
     * Deletes the drafts and unsent messages, revokes this device's credential
     * on the server if it answers, then deletes the credential. The device is
     * unpaired only once that deletion succeeded.
     */
    readonly run: Effect.Effect<SignOutResult>;
  }
>()("@j3-bots/client-runtime/intents/SignOut") {}

export const layer = Layer.effect(
  SignOut,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const devices = yield* Devices;
    const drafts = yield* Drafts;
    const conversations = yield* Conversations;

    /** Whether the server revoked this device. Revoking it closes its socket, so the answer is often `not-paired`. */
    const revokeThis = Effect.gen(function* () {
      if (connection.state.get()._tag !== "connected") return false;
      const deviceId = yield* connection.deviceId;
      const result = yield* devices.revoke(deviceId);
      if (result._tag === "done") return true;
      const { failure } = result;
      return (
        failure._tag === "not-paired" ||
        (failure._tag === "refused" && failure.error._tag === "NotFound")
      );
    }).pipe(
      Effect.catchTag("NotPaired", () => Effect.succeed(false)),
      Effect.timeoutOption(REVOKE_WAIT),
      Effect.map(Option.getOrElse(() => false)),
    );

    const run = Effect.gen(function* () {
      const erased = yield* Effect.all([drafts.discardAll, conversations.discardAll], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.as(true),
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("Drafts or unsent messages could not be deleted", error).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!erased) return "failed";
      const revoked = yield* revokeThis;
      const reason = revoked ? "signed-out" : "still-listed";
      return yield* connection.forget(reason).pipe(
        Effect.as<SignOutResult>(reason),
        Effect.catchTag("CredentialStorageError", (error) =>
          Effect.logWarning("The credential could not be deleted", error).pipe(
            Effect.as<SignOutResult>("failed"),
          ),
        ),
      );
    });

    return SignOut.of({ run });
  }),
);
