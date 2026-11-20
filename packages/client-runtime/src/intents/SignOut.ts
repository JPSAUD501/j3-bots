// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection } from "../connection/Connection.ts";
import type { LocalStorageError } from "../ports.ts";
import { Conversations } from "../stores/Conversations.ts";
import { Devices } from "../stores/Devices.ts";
import { Drafts } from "../stores/Drafts.ts";

/**
 * What signing out did. Every step is attempted whatever the others did, and
 * each failure is logged on its own.
 */
export type SignOutResult =
  /** The server revoked this device, and its credential is deleted here. */
  | "signed-out"
  /** Its credential is deleted here, but the server was out of reach and still lists it. */
  | "still-listed"
  /** Its credential could not be deleted, so the device is still signed in here. */
  | "failed";

/** Ends this device's access: on the server when it can be reached, and here in any case. */
export class SignOut extends Context.Service<
  SignOut,
  {
    /**
     * Stops sending, revokes this device on the server if it is connected,
     * deletes the drafts and unsent messages, then deletes the credential.
     * The device is unpaired only once that deletion succeeded; without a
     * credential, whatever text is left is discarded again.
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
      switch (result._tag) {
        case "done":
          return true;
        case "unanswered":
          return false;
        case "failed":
          return (
            result.failure._tag === "not-paired" ||
            (result.failure._tag === "refused" && result.failure.error._tag === "NotFound")
          );
      }
    }).pipe(Effect.catchTag("NotPaired", () => Effect.succeed(false)));

    const erase = (deleted: Effect.Effect<void, LocalStorageError>, what: string) =>
      deleted.pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning(`${what} could not be deleted`, error),
        ),
      );

    const run = conversations.withSendingPaused(
      Effect.gen(function* () {
        const revoked = yield* revokeThis;
        yield* erase(drafts.discardAll, "Drafts");
        yield* erase(conversations.discardAll, "Unsent messages");
        const reason = revoked ? "signed-out" : "still-listed";
        return yield* connection.forget(reason).pipe(
          Effect.as<SignOutResult>(reason),
          Effect.catchTag("CredentialStorageError", (error) =>
            Effect.logWarning("The credential could not be deleted", error).pipe(
              Effect.as<SignOutResult>("failed"),
            ),
          ),
        );
      }),
    );

    return SignOut.of({ run });
  }),
);
