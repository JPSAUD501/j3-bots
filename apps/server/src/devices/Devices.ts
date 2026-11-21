// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandId,
  type Conflict,
  Device,
  DeviceId,
  DeviceToken,
  Invalid,
  Label,
  NotFound,
  PAIRING_CODE_LENGTH,
  PairingCode,
  type PairResult,
  type PushRegistration,
  RateLimited,
} from "@j3-bots/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { hashDeviceToken } from "../auth/DeviceAuth.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Ids } from "../Ids.ts";
import { Flag, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

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
  push_registered: Flag,
});

/** A device paired and not revoked, and whether it registered for push. */
export interface PairedDevice {
  readonly id: DeviceId;
  readonly pushRegistered: boolean;
}

const PairedRow = Schema.Struct({ id: DeviceId, push_registered: Flag });

/**
 * Paired clients, pairing a new one, and where to push to each. A code is
 * shown on a paired client, works once within five minutes, and is exchanged
 * for a device token, of which only the hash is stored. Failed attempts count
 * across every source: five within fifteen minutes lock pairing for fifteen
 * minutes. Codes and failures live in memory, so a restart of the server
 * forgets both. A push registration is stored, one per device at most, and
 * revoking the device deletes it (`DeviceAuth.revoke`).
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
    /** How many devices are paired and not revoked. */
    readonly pairedCount: Effect.Effect<number>;
    /**
     * The devices paired and not revoked, oldest first. One read, through the
     * current transaction.
     */
    readonly paired: Effect.Effect<ReadonlyArray<PairedDevice>>;
    /**
     * Stores where to push to the device, replacing its earlier registration
     * and taking the token from any other device that held it, once per
     * command. `NotFound("device")` when the device is revoked, even for a
     * command it sent before.
     */
    readonly registerPush: (input: {
      readonly commandId: CommandId;
      readonly deviceId: DeviceId;
      readonly registration: PushRegistration;
    }) => Effect.Effect<void, NotFound | Conflict>;
    /**
     * Deletes the device's push registration, if it has one, once per command.
     * `NotFound("device")` when the device is revoked, even for a command it
     * sent before.
     */
    readonly unregisterPush: (input: {
      readonly commandId: CommandId;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<void, NotFound | Conflict>;
  }
>()("@j3-bots/server/devices/Devices") {}

export const layer = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const ids = yield* Ids;
    const receipts = yield* CommandReceipts;
    const codes = new Map<string, number>();
    let failures: ReadonlyArray<number> = [];
    let lockedUntil = 0;

    const deviceRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: DeviceRow,
      execute: () => sql`
        SELECT d.id, d.name, d.paired_at, d.last_seen_at,
          p.device_id IS NOT NULL AS push_registered
        FROM devices d LEFT JOIN push_registrations p ON p.device_id = d.id
        WHERE d.revoked_at IS NULL ORDER BY d.paired_at, d.id
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
      return rows.map((row): Device => ({
        id: row.id,
        name: row.name,
        pairedAt: row.paired_at,
        lastSeenAt: row.last_seen_at,
        current: row.id === current,
        pushRegistered: row.push_registered,
      }));
    });

    const pairedCount = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Int }),
      execute: () => sql`SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL`,
    })(undefined).pipe(
      Effect.map(({ count }) => count),
      Effect.orDie,
    );

    const paired = SqlSchema.findAll({
      Request: Schema.Void,
      Result: PairedRow,
      execute: () => sql`
        SELECT d.id, p.device_id IS NOT NULL AS push_registered
        FROM devices d LEFT JOIN push_registrations p ON p.device_id = d.id
        WHERE d.revoked_at IS NULL ORDER BY d.paired_at, d.id
      `,
    })(undefined).pipe(
      Effect.map((rows) =>
        rows.map((row): PairedDevice => ({ id: row.id, pushRegistered: row.push_registered })),
      ),
      Effect.orDie,
    );

    const isPaired = SqlSchema.findOneOption({
      Request: DeviceId,
      Result: Schema.Struct({ id: DeviceId }),
      execute: (id) => sql`SELECT id FROM devices WHERE id = ${id} AND revoked_at IS NULL`,
    });

    /**
     * Runs a device's command only while the device is paired. The check comes
     * before the command's receipt is read, in the same transaction, so a
     * command replayed after the device was revoked is refused rather than
     * answered from its receipt, and a revocation cannot slip in between.
     */
    const asPairedDevice = <A, E, R>(
      deviceId: DeviceId,
      command: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | NotFound, R> =>
      Effect.gen(function* () {
        if (Option.isNone(yield* isPaired(deviceId).pipe(Effect.orDie))) {
          return yield* new NotFound({ resource: "device" });
        }
        return yield* command;
      }).pipe(transactional(sql));

    const registerPush = Effect.fn("Devices.registerPush")(function* (input: {
      readonly commandId: CommandId;
      readonly deviceId: DeviceId;
      readonly registration: PushRegistration;
    }) {
      const { provider, token, platform, language } = input.registration;
      yield* asPairedDevice(
        input.deviceId,
        receipts.once({
          commandId: input.commandId,
          method: "push.register",
          payload: { deviceId: input.deviceId, ...input.registration },
          result: Schema.Void,
          apply: Effect.gen(function* () {
            const at = timeText(yield* DateTime.now);
            yield* sql`
              DELETE FROM push_registrations
              WHERE provider = ${provider} AND token = ${token} AND device_id <> ${input.deviceId}
            `.pipe(Effect.orDie);
            yield* sql`
              INSERT INTO push_registrations (device_id, provider, token, platform, language, updated_at)
              VALUES (${input.deviceId}, ${provider}, ${token}, ${platform}, ${language}, ${at})
              ON CONFLICT (device_id) DO UPDATE SET
                provider = excluded.provider,
                token = excluded.token,
                platform = excluded.platform,
                language = excluded.language,
                updated_at = excluded.updated_at,
                failures = 0
            `.pipe(Effect.orDie);
          }),
        }),
      );
    });

    const unregisterPush = Effect.fn("Devices.unregisterPush")(function* (input: {
      readonly commandId: CommandId;
      readonly deviceId: DeviceId;
    }) {
      yield* asPairedDevice(
        input.deviceId,
        receipts.once({
          commandId: input.commandId,
          method: "push.unregister",
          payload: { deviceId: input.deviceId },
          result: Schema.Void,
          apply: sql`DELETE FROM push_registrations WHERE device_id = ${input.deviceId}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        }),
      );
    });

    return Devices.of({
      startPairing,
      pair,
      list,
      pairedCount,
      paired,
      registerPush,
      unregisterPush,
    });
  }),
).pipe(Layer.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]));
