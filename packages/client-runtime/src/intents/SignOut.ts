// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId } from "@j3-bots/contracts";
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
  /**
   * A pairing made while it signed out, here or in another window, stays, and
   * this window follows it: the device is signed in under that pairing.
   */
  | "paired-anew"
  /** Its credential could not be deleted, so the device is still signed in here. */
  | "failed";

/** Ends this device's access: on the server when it can be reached, and here in any case. */
export class SignOut extends Context.Service<
  SignOut,
  {
    /**
     * Stops sending, revokes this device's pairing on the server if it is
     * connected, deletes that pairing's drafts and unsent messages, then its
     * credential. The pairing is the one this window follows when it is
     * called, read before anything waits, and every step acts on it alone. The
     * device is unpaired only once that deletion succeeded; without a
     * credential, whatever text is left is discarded again. A pairing made
     * meanwhile, here or in another window, keeps all of its own.
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

    /** Whether the server revoked `pairing`. Revoking it closes its socket, so the answer is often `not-paired`. */
    const revoke = Effect.fn("SignOut.revoke")(function* (pairing: DeviceId) {
      if (connection.state.get()._tag !== "connected") return false;
      const result = yield* devices.revoke(pairing);
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
    });

    const erase = (deleted: Effect.Effect<void, LocalStorageError>, what: string) =>
      deleted.pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning(`${what} could not be deleted`, error),
        ),
      );

    const run = Effect.suspend(() => {
      // The pairing this ends, read before anything waits: stopping the
      // deliveries waits for an answer being recorded, and meanwhile another
      // window may pair anew and this window follow it. That pairing stays.
      const pairing = connection.pairing.get();
      return conversations.withSendingPaused(
        Effect.gen(function* () {
          const revoked = pairing !== null && (yield* revoke(pairing));
          yield* erase(drafts.discardAll(pairing), "Drafts");
          yield* erase(conversations.discardAll(pairing), "Unsent messages");
          const reason = revoked ? "signed-out" : "still-listed";
          return yield* connection.forget(reason, pairing).pipe(
            Effect.map((forgotten): SignOutResult =>
              forgotten === "paired-anew" ? "paired-anew" : reason,
            ),
            Effect.catchTag("CredentialStorageError", (error) =>
              Effect.logWarning("The credential could not be deleted", error).pipe(
                Effect.as<SignOutResult>("failed"),
              ),
            ),
          );
        }),
      );
    });

    return SignOut.of({ run });
  }),
);
