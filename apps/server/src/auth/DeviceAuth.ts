// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DeviceId,
  NotAuthenticated,
  NotFound,
  SocketTicket,
  type SocketTicketGrant,
} from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** How a socket upgrade proves which device it is. */
export type SocketCredential =
  | { readonly _tag: "bearer"; readonly token: string }
  | { readonly _tag: "ticket"; readonly ticket: string };

/** The paired device a socket belongs to, for every request on it. */
export class CurrentDevice extends Context.Service<CurrentDevice, { readonly id: DeviceId }>()(
  "@j3-bots/server/auth/DeviceAuth/CurrentDevice",
) {}

const TICKET_LIFETIME_MILLIS = 60_000;

const encoder = new TextEncoder();

/** What the `devices` table stores for a token: its SHA-256, in hex. */
export const hashDeviceToken = (token: string) =>
  Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, encoder.encode(token)));

/**
 * Who may open a socket, and when a socket must close. A socket is
 * authenticated once, at its upgrade, and closes as soon as its device is
 * revoked.
 */
export class DeviceAuth extends Context.Service<
  DeviceAuth,
  {
    /** The paired, unrevoked device the credential belongs to. A ticket works once. */
    readonly authenticate: (
      credential: SocketCredential,
    ) => Effect.Effect<DeviceId, NotAuthenticated>;
    /** A ticket for a client that cannot send an `Authorization` header on an upgrade. */
    readonly issueTicket: (deviceId: DeviceId) => Effect.Effect<SocketTicketGrant>;
    /** Refuses the device's token from now on and closes its sockets. Succeeds if already revoked. */
    readonly revoke: (deviceId: DeviceId) => Effect.Effect<void, NotFound>;
    /** Completes once the device is revoked: at once if it already is. */
    readonly revoked: (deviceId: DeviceId) => Effect.Effect<void>;
  }
>()("@j3-bots/server/auth/DeviceAuth") {}

const DeviceRow = Schema.Struct({ id: DeviceId, revoked_at: Schema.NullOr(Schema.String) });

export const layer = Layer.effect(
  DeviceAuth,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const tickets = new Map<string, { readonly deviceId: DeviceId; readonly expiresAt: number }>();
    const revocations = new Map<DeviceId, Deferred.Deferred<void>>();

    const findByTokenHash = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: DeviceRow,
      execute: (hash) => sql`SELECT id, revoked_at FROM devices WHERE token_hash = ${hash}`,
    });
    const findById = SqlSchema.findOneOption({
      Request: DeviceId,
      Result: DeviceRow,
      execute: (id) => sql`SELECT id, revoked_at FROM devices WHERE id = ${id}`,
    });

    const activeDevice = (row: Option.Option<typeof DeviceRow.Type>) =>
      Option.isSome(row) && row.value.revoked_at === null
        ? Effect.succeed(row.value.id)
        : Effect.fail(new NotAuthenticated());

    const authenticate = Effect.fn("DeviceAuth.authenticate")(function* (
      credential: SocketCredential,
    ) {
      if (credential._tag === "ticket") {
        const ticket = tickets.get(credential.ticket);
        tickets.delete(credential.ticket);
        if (ticket === undefined || ticket.expiresAt <= (yield* Clock.currentTimeMillis)) {
          return yield* new NotAuthenticated();
        }
        // A database that cannot be read, or holds a malformed row, is a defect
        // and never lets a socket in.
        return yield* activeDevice(yield* findById(ticket.deviceId).pipe(Effect.orDie));
      }
      const hash = yield* hashDeviceToken(credential.token).pipe(
        Effect.provideService(Digest.Digest, digest),
      );
      return yield* activeDevice(yield* findByTokenHash(hash).pipe(Effect.orDie));
    });

    const issueTicket = Effect.fn("DeviceAuth.issueTicket")(function* (deviceId: DeviceId) {
      const now = yield* Clock.currentTimeMillis;
      for (const [value, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(value);
      const ticket = SocketTicket.make(Base64Url.encode(yield* random.randomBytes(32)));
      const expiresAt = now + TICKET_LIFETIME_MILLIS;
      tickets.set(ticket, { deviceId, expiresAt });
      return { ticket, expiresAt: DateTime.makeUnsafe(expiresAt) };
    });

    const signal = (deviceId: DeviceId) => {
      let revocation = revocations.get(deviceId);
      if (revocation === undefined) {
        revocation = Deferred.makeUnsafe<void>();
        revocations.set(deviceId, revocation);
      }
      return revocation;
    };

    const revoke = Effect.fn("DeviceAuth.revoke")(function* (deviceId: DeviceId) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE devices SET revoked_at = ${at} WHERE id = ${deviceId} AND revoked_at IS NULL`.pipe(
        Effect.orDie,
      );
      const row = yield* findById(deviceId).pipe(Effect.orDie);
      if (Option.isNone(row)) return yield* new NotFound({ resource: "device" });
      for (const [value, ticket] of tickets)
        if (ticket.deviceId === deviceId) tickets.delete(value);
      yield* Deferred.succeed(signal(deviceId), undefined);
    });

    const revoked = Effect.fn("DeviceAuth.revoked")(function* (deviceId: DeviceId) {
      // Take the signal before reading the row, so a revocation in between is not missed.
      const revocation = signal(deviceId);
      const row = yield* findById(deviceId).pipe(Effect.orDie);
      if (Option.isSome(row) && row.value.revoked_at === null) yield* Deferred.await(revocation);
    });

    return DeviceAuth.of({ authenticate, issueTicket, revoke, revoked });
  }),
).pipe(Layer.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]));
