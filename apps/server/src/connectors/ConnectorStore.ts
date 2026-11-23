// SPDX-License-Identifier: AGPL-3.0-or-later
import { CatalogTool, ConnectorSlug, slugFor } from "@j3-bots/connectors";
import {
  BotId,
  ConnectorField,
  ConnectorGlyph,
  type ConnectorGrant,
  ConnectorId,
  ConnectorPublisher,
  ConnectorSignIn,
  ConnectorTransport,
  Label,
  ListingRef,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Flag, json, Time, timeText } from "../persistence/columns.ts";
import { usesVault } from "./credentials.ts";

/**
 * A connector as the server keeps it: what the operator added, with none of
 * its secrets, which are in the vault under its id. Its status is not kept:
 * the `Connectors` service works it out from the vault, the sign-in and how
 * the connector's server last answered.
 */
export interface StoredConnector {
  readonly id: ConnectorId;
  readonly name: string;
  /** Names its tools for bots: `<slug>__<tool>`. */
  readonly slug: ConnectorSlug;
  readonly glyph: ConnectorGlyph | null;
  readonly publisher: ConnectorPublisher;
  readonly listing: ListingRef | null;
  /** What a client is shown of how it is reached: a remote one's origin, a command's program. */
  readonly transport: ConnectorTransport;
  readonly signIn: ConnectorSignIn;
  readonly fields: ReadonlyArray<ConnectorField>;
  /** The operator confirmed an address in their own network. */
  readonly privateNetwork: boolean;
  readonly grant: ConnectorGrant;
  /** When the operator last gave its form's values; an OAuth sign-in's time is the sign-in's own. */
  readonly signedInAt: DateTime.Utc | null;
  /** The tools the operator accepted; null until its server first listed them. */
  readonly accepted: ReadonlyArray<CatalogTool> | null;
  /** The review the operator answered with "keep", which stays closed until the tools change again. */
  readonly keptRevision: string | null;
  readonly createdAt: DateTime.Utc;
}

/** What is left to do for a connector already removed: what waits for an unlocked vault. */
export interface PendingRemoval {
  readonly id: ConnectorId;
  /** Its OAuth sign-in is to be revoked at the service. */
  readonly revoke: boolean;
  /** Its vault record is to be deleted. */
  readonly secrets: boolean;
}

/**
 * What may change of a stored connector after it was added. A command
 * connector's program, the fields its environment takes, and so whether it
 * signs in by them, change with its command.
 */
export type ConnectorChanges = Partial<
  Pick<
    StoredConnector,
    | "name"
    | "grant"
    | "signedInAt"
    | "accepted"
    | "keptRevision"
    | "transport"
    | "fields"
    | "signIn"
  >
>;

const Row = Schema.Struct({
  id: ConnectorId,
  name: Label,
  slug: ConnectorSlug,
  glyph: Schema.NullOr(ConnectorGlyph),
  publisher_json: json(ConnectorPublisher),
  listing_json: Schema.NullOr(json(ListingRef)),
  transport_json: json(ConnectorTransport),
  sign_in: ConnectorSignIn,
  fields_json: json(Schema.Array(ConnectorField)),
  private_network: Flag,
  all_bots: Flag,
  signed_in_at: Schema.NullOr(Time),
  tools_json: Schema.NullOr(json(Schema.Array(CatalogTool))),
  kept_revision: Schema.NullOr(Schema.String),
  created_at: Time,
});
type Row = typeof Row.Type;

const GrantRow = Schema.Struct({ connector_id: ConnectorId, bot_id: BotId });

const RemovalRow = Schema.Struct({ connector_id: ConnectorId, revoke: Flag, secrets: Flag });

const COLUMNS = `id, name, slug, glyph, publisher_json, listing_json, transport_json, sign_in,
  fields_json, private_network, all_bots, signed_in_at, tools_json, kept_revision, created_at`;

const encodePublisher = Schema.encodeSync(json(ConnectorPublisher));
const encodeListing = Schema.encodeSync(json(ListingRef));
const encodeTransport = Schema.encodeSync(json(ConnectorTransport));
const encodeFields = Schema.encodeSync(json(Schema.Array(ConnectorField)));
const encodeTools = Schema.encodeSync(json(Schema.Array(CatalogTool)));

const toStored = (row: Row, bots: ReadonlyArray<BotId>): StoredConnector => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  glyph: row.glyph,
  publisher: row.publisher_json,
  listing: row.listing_json,
  transport: row.transport_json,
  signIn: row.sign_in,
  fields: row.fields_json,
  privateNetwork: row.private_network,
  grant: row.all_bots ? { _tag: "all-bots" } : { _tag: "bots", ids: bots },
  signedInAt: row.signed_in_at,
  accepted: row.tools_json,
  keptRevision: row.kept_revision,
  createdAt: row.created_at,
});

/**
 * The connectors table. It takes what it is given: checking a source, the
 * vault and the bots a grant names is the `Connectors` service's.
 */
export class ConnectorStore extends Context.Service<
  ConnectorStore,
  {
    readonly get: (id: ConnectorId) => Effect.Effect<Option.Option<StoredConnector>>;
    /** Every connector, oldest first. */
    readonly all: Effect.Effect<ReadonlyArray<StoredConnector>>;
    /**
     * Adds the connector, with a slug from its name that no other connector
     * has, chosen in the same transaction. None when a connector with its id
     * is already there.
     */
    readonly insert: (
      connector: Omit<StoredConnector, "slug">,
    ) => Effect.Effect<Option.Option<StoredConnector>>;
    readonly update: (
      id: ConnectorId,
      changes: ConnectorChanges,
      at: DateTime.Utc,
    ) => Effect.Effect<Option.Option<StoredConnector>>;
    /**
     * Removes the connector, and records in the same transaction what is
     * left to do for it ({@link PendingRemoval}); one already gone is no error.
     */
    readonly remove: (id: ConnectorId) => Effect.Effect<void>;
    /** The removals not done yet. */
    readonly pendingRemovals: Effect.Effect<ReadonlyArray<PendingRemoval>>;
    /** What was left to do for the removed connector is done. */
    readonly removalDone: (id: ConnectorId) => Effect.Effect<void>;
  }
>()("@j3-bots/server/connectors/ConnectorStore") {}

export const layer = Layer.effect(
  ConnectorStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const findRow = SqlSchema.findOneOption({
      Request: ConnectorId,
      Result: Row,
      execute: (id) => sql`SELECT ${sql.literal(COLUMNS)} FROM connectors WHERE id = ${id}`,
    });
    const allRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Row,
      execute: () => sql`SELECT ${sql.literal(COLUMNS)} FROM connectors ORDER BY created_at, id`,
    });
    const grantRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: GrantRow,
      execute: () =>
        sql`SELECT connector_id, bot_id FROM connector_bots ORDER BY connector_id, bot_id`,
    });
    const grantRowsOf = SqlSchema.findAll({
      Request: ConnectorId,
      Result: GrantRow,
      execute: (id) =>
        sql`SELECT connector_id, bot_id FROM connector_bots WHERE connector_id = ${id} ORDER BY bot_id`,
    });
    const slugRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ slug: Schema.String }),
      execute: () => sql`SELECT slug FROM connectors`,
    });

    const get = Effect.fn("ConnectorStore.get")(function* (id: ConnectorId) {
      const row = yield* findRow(id);
      if (Option.isNone(row)) return Option.none<StoredConnector>();
      const grants = yield* grantRowsOf(id);
      return Option.some(
        toStored(
          row.value,
          grants.map((grant) => grant.bot_id),
        ),
      );
    }, Effect.orDie);

    const all = Effect.gen(function* () {
      const rows = yield* allRows(undefined);
      const grants = yield* grantRows(undefined);
      const byConnector = new Map<ConnectorId, Array<BotId>>();
      for (const grant of grants) {
        const bots = byConnector.get(grant.connector_id) ?? [];
        bots.push(grant.bot_id);
        byConnector.set(grant.connector_id, bots);
      }
      return rows.map((row) => toStored(row, byConnector.get(row.id) ?? []));
    }).pipe(Effect.orDie);

    const removalRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: RemovalRow,
      execute: () => sql`SELECT connector_id, revoke, secrets FROM connector_removals`,
    });

    const writeGrant = Effect.fn("ConnectorStore.writeGrant")(function* (
      id: ConnectorId,
      grant: ConnectorGrant,
    ) {
      yield* sql`DELETE FROM connector_bots WHERE connector_id = ${id}`;
      if (grant._tag === "bots") {
        for (const botId of new Set(grant.ids)) {
          yield* sql`
            INSERT INTO connector_bots (connector_id, bot_id)
            SELECT ${id}, id FROM bots WHERE id = ${botId}
          `;
        }
      }
    });

    const insert = Effect.fn("ConnectorStore.insert")(
      function* (draft: Omit<StoredConnector, "slug">) {
        if (Option.isSome(yield* findRow(draft.id))) return Option.none<StoredConnector>();
        const taken = yield* slugRows(undefined);
        const connector: StoredConnector = {
          ...draft,
          slug: slugFor(draft.name, new Set(taken.map((row) => row.slug))),
        };
        const at = timeText(connector.createdAt);
        yield* sql`
        INSERT INTO connectors (
          id, name, slug, glyph, publisher_json, listing_json, transport_json, sign_in,
          fields_json, private_network, all_bots, signed_in_at, tools_json,
          kept_revision, created_at, updated_at
        ) VALUES (
          ${connector.id}, ${connector.name}, ${connector.slug}, ${connector.glyph},
          ${encodePublisher(connector.publisher)},
          ${connector.listing === null ? null : encodeListing(connector.listing)},
          ${encodeTransport(connector.transport)}, ${connector.signIn},
          ${encodeFields(connector.fields)}, ${connector.privateNetwork ? 1 : 0},
          ${connector.grant._tag === "all-bots" ? 1 : 0},
          ${connector.signedInAt === null ? null : timeText(connector.signedInAt)},
          ${connector.accepted === null ? null : encodeTools(connector.accepted)},
          ${connector.keptRevision}, ${at}, ${at}
        )
      `;
        yield* writeGrant(connector.id, connector.grant);
        return yield* get(connector.id);
      },
      sql.withTransaction,
      Effect.orDie,
    );

    const update = Effect.fn("ConnectorStore.update")(
      function* (id: ConnectorId, changes: ConnectorChanges, at: DateTime.Utc) {
        const current = yield* get(id);
        if (Option.isNone(current)) return current;
        const next: StoredConnector = { ...current.value, ...changes };
        yield* sql`
          UPDATE connectors SET
            name = ${next.name},
            transport_json = ${encodeTransport(next.transport)},
            sign_in = ${next.signIn},
            fields_json = ${encodeFields(next.fields)},
            all_bots = ${next.grant._tag === "all-bots" ? 1 : 0},
            signed_in_at = ${next.signedInAt === null ? null : timeText(next.signedInAt)},
            tools_json = ${next.accepted === null ? null : encodeTools(next.accepted)},
            kept_revision = ${next.keptRevision},
            updated_at = ${timeText(at)}
          WHERE id = ${id}
        `;
        if (changes.grant !== undefined) yield* writeGrant(id, changes.grant);
        return yield* get(id);
      },
      sql.withTransaction,
      Effect.orDie,
    );

    const remove = Effect.fn("ConnectorStore.remove")(
      function* (id: ConnectorId) {
        const connector = yield* get(id);
        if (Option.isNone(connector)) return;
        const revoke = connector.value.signIn === "oauth" ? 1 : 0;
        const secrets = usesVault(connector.value) ? 1 : 0;
        yield* sql`
          INSERT INTO connector_removals (connector_id, revoke, secrets)
          VALUES (${id}, ${revoke}, ${secrets})
          ON CONFLICT (connector_id) DO NOTHING
        `;
        yield* sql`DELETE FROM connectors WHERE id = ${id}`;
      },
      sql.withTransaction,
      Effect.orDie,
    );

    const pendingRemovals = removalRows(undefined).pipe(
      Effect.map((rows) =>
        rows.map((row): PendingRemoval => ({
          id: row.connector_id,
          revoke: row.revoke,
          secrets: row.secrets,
        })),
      ),
      Effect.orDie,
    );

    const removalDone = Effect.fn("ConnectorStore.removalDone")(function* (id: ConnectorId) {
      yield* sql`DELETE FROM connector_removals WHERE connector_id = ${id}`.pipe(Effect.orDie);
    });

    return { get, all, insert, update, remove, pendingRemovals, removalDone };
  }),
);
