// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_LABEL_LENGTH } from "@j3-bots/contracts";
import type { LocalDeviceRequest, LocalDeviceResult } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { DesktopSettings } from "../settings.ts";
import type { Supervisor } from "./supervisor.ts";

// Signs this computer in to the server it runs, with no pairing code: the
// server mints an ordinary device, listed and revocable like any other, on
// its admin channel, which only this process holds, never over TCP. The
// token goes to the page, which seals and keeps it as after pairing; the app
// keeps only the device's id, which the next sign-in replaces.
//
// The app never signs in again by itself. A device revoked from the phone
// stays signed out until the operator asks, here, to sign in again: only the
// first sign-in after the operator chose this computer needs no asking.

/** The device name this computer signs in as: its own name, as a label holds it. */
export const deviceName = (hostname: string): string => {
  const name = hostname.trim().slice(0, MAX_LABEL_LENGTH);
  return name.length > 0 ? name : "This computer";
};

/** Signs this computer in, one request at a time. */
export const make = Effect.fn("LocalCredential.make")(function* (options: {
  readonly supervisor: Pick<Supervisor, "ready">;
  readonly name: string;
}) {
  const settings = yield* DesktopSettings;
  const oneAtATime = yield* Semaphore.make(1);

  return (request: LocalDeviceRequest): Effect.Effect<LocalDeviceResult> =>
    oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        const before = yield* settings.get;
        if (before.mode !== "local" || before.server === null) {
          return { _tag: "not-running" } as const;
        }
        if (!request.again && before.localDevice?.current === true) {
          return { _tag: "signed-out" } as const;
        }
        const server = yield* options.supervisor.ready.pipe(Effect.option);
        if (server._tag === "None") return { _tag: "not-running" } as const;
        const { pid, admin } = server.value;
        // The channel is the child's own, so it answers for the child; a
        // server that says otherwise is not one to sign a device in on.
        const status = yield* admin.status().pipe(Effect.option);
        if (status._tag === "None") return { _tag: "not-running" } as const;
        if (status.value.pid !== pid) {
          yield* Effect.logError(
            "The local server's status names another process; no device was signed in",
            {
              expected: pid,
              answered: status.value.pid,
            },
          );
          return { _tag: "failed" } as const;
        }
        const minted = yield* admin
          .localDevice({ name: options.name, replaces: before.localDevice?.id ?? null })
          .pipe(Effect.option);
        if (minted._tag === "None") return { _tag: "failed" } as const;
        const { deviceId, token } = minted.value;
        yield* settings
          .update((current) => ({ ...current, localDevice: { id: deviceId, current: true } }))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Keeping the id of this computer's device failed", error),
            ),
          );
        return { _tag: "minted", server: before.server, deviceId, token } as const;
      }),
    );
});
