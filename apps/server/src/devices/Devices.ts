// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Device,
  DeviceId,
  DeviceToken,
  Invalid,
  Label,
  PAIRING_CODE_LENGTH,
  PairingCode,
  type PairResult,
  RateLimited,
} from "@j3-bots/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { hashDeviceToken } from "../auth/DeviceAuth.ts";
import { Ids } from "../Ids.ts";
import { Time, timeText } from "../persistence/columns.ts";

/** Crockford base32 in upper case, as `PairingCode` takes it. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LIFETIME_MILLIS = 5 * 60_000;
/** Failures within this window count towards a lockout (`docs/architecture/security.md`). */
const FAILURE_WINDOW_MILLIS = 15 * 60_000;
const FAILURES_BEFORE_LOCKOUT = 5;
const LOCKOUT_MILLIS = 15 * 60_000;

const DeviceRow = Schema.Struct({
  id: DeviceId,
  name: Label,
  paired_at: Time,
  last_seen_at: Schema.NullOr(Time),
});

/**
 * Paired clients, and pairing a new one. A code is shown on a paired client,
 * works once within five minutes, and is exchanged for a device token, of
 * which only the hash is stored. Failed attempts count across every source:
 * five within fifteen minutes lock pairing for fifteen minutes. Codes and
 * failures live in memory, so a restart of the server forgets both.
 */
export class Devices extends Context.Service<
  Devices,
  {
    readonly startPairing: Effect.Effect<{
      readonly code: PairingCode;
      readonly expiresAt: DateTime.Utc;
    }>;
    readonly pair: (input: {
      readonly code: PairingCode;
      readonly name: string;
    }) => Effect.Effect<PairResult, Invalid | RateLimited>;
    /** Devices not revoked, oldest first, marking the one `current` names. */
    readonly list: (current: DeviceId) => Effect.Effect<ReadonlyArray<Device>>;
  }
>()("@j3-bots/server/devices/Devices") {}

export const layer = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const ids = yield* Ids;
    const codes = new Map<string, number>();
    let failures: ReadonlyArray<number> = [];
    let lockedUntil = 0;

    const deviceRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: DeviceRow,
      execute: () => sql`
        SELECT id, name, paired_at, last_seen_at FROM devices
        WHERE revoked_at IS NULL ORDER BY paired_at, id
      `,
    });

    const startPairing = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [code, expiresAt] of codes) if (expiresAt <= now) codes.delete(code);
      let code = "";
      for (const byte of yield* random.randomBytes(PAIRING_CODE_LENGTH)) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
      const expiresAt = now + CODE_LIFETIME_MILLIS;
      codes.set(code, expiresAt);
      return { code: PairingCode.make(code), expiresAt: DateTime.makeUnsafe(expiresAt) };
    });

    const pair = Effect.fn("Devices.pair")(function* (input: {
      readonly code: PairingCode;
      readonly name: string;
    }) {
      const now = yield* Clock.currentTimeMillis;
      if (lockedUntil > now) {
        return yield* new RateLimited({ retryAt: DateTime.makeUnsafe(lockedUntil) });
      }
      const expiresAt = codes.get(input.code);
      codes.delete(input.code);
      if (expiresAt === undefined || expiresAt <= now) {
        failures = [...failures.filter((at) => at > now - FAILURE_WINDOW_MILLIS), now];
        if (failures.length >= FAILURES_BEFORE_LOCKOUT) {
          failures = [];
          lockedUntil = now + LOCKOUT_MILLIS;
        }
        return yield* new Invalid({ reason: "pairing-code" });
      }
      const token = DeviceToken.make(Base64Url.encode(yield* random.randomBytes(32)));
      const tokenHash = yield* hashDeviceToken(token).pipe(
        Effect.provideService(Digest.Digest, digest),
      );
      const deviceId = DeviceId.make(yield* ids.make("device"));
      yield* sql`
        INSERT INTO devices (id, name, token_hash, paired_at)
        VALUES (${deviceId}, ${input.name}, ${tokenHash}, ${timeText(DateTime.makeUnsafe(now))})
      `.pipe(Effect.orDie);
      return { deviceId, token } satisfies PairResult;
    });

    const list = Effect.fn("Devices.list")(function* (current: DeviceId) {
      const rows = yield* deviceRows(undefined).pipe(Effect.orDie);
      return rows.map(
        (row): Device => ({
          id: row.id,
          name: row.name,
          pairedAt: row.paired_at,
          lastSeenAt: row.last_seen_at,
          current: row.id === current,
        }),
      );
    });

    return Devices.of({ startPairing, pair, list });
  }),
).pipe(Layer.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]));
