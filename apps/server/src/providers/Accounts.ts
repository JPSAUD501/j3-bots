// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandId,
  type CommandError,
  Conflict,
  type EngineStatus,
  Label,
  LaunchArguments,
  NotFound,
  ProviderId,
  ProviderPath,
  SignInHarness,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { ServerConfig } from "../config.ts";
import { engineProviders } from "../engine/providers.ts";
import { homeLayout } from "../home/entries.ts";
import { Ids } from "../Ids.ts";
import { Flag } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";

// The AI accounts the operator sets up (decision 0108): each a Claude Code or
// Codex provider of the engine, signed in in a home of its own. The first of
// each harness has the harness's id, as every install had; the operator adds
// more, and removes only those.

/** One AI account, as the server keeps it. */
export interface ProviderAccount {
  readonly id: ProviderId;
  readonly harness: SignInHarness;
  readonly name: string;
  readonly enabled: boolean;
  /** The executable the operator chose; null for J3 Bots' copy, or the one on `PATH`. */
  readonly binaryPath: string | null;
  readonly launchArguments: string;
  /** The operator added it: the first of each harness was not. */
  readonly added: boolean;
}

const AccountRow = Schema.Struct({
  id: ProviderId,
  harness: SignInHarness,
  name: Label,
  enabled: Flag,
  binary_path: Schema.NullOr(ProviderPath),
  launch_arguments: LaunchArguments,
  added: Flag,
});

const accountOf = (row: typeof AccountRow.Type): ProviderAccount => ({
  id: row.id,
  harness: row.harness,
  name: row.name,
  enabled: row.enabled,
  binaryPath: row.binary_path,
  launchArguments: row.launch_arguments,
  added: row.added,
});

/** The accounts in the order the operator added them, each harness's first first. */
export const readAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: AccountRow,
    execute: () => sql`
      SELECT id, harness, name, enabled, binary_path, launch_arguments, added
      FROM provider_accounts ORDER BY position
    `,
  })(undefined);
  return rows.map(accountOf);
}).pipe(Effect.orDie);

/** The first account of `harness`, which every install has and none can remove. */
export const firstAccount = (harness: SignInHarness): ProviderId => ProviderId.make(harness);

/** What `engine.setUpProvider` changes; fields left out keep their value. */
export interface AccountChanges {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly binaryPath?: string | null;
  readonly launchArguments?: string;
}

export class ProviderAccounts extends Context.Service<
  ProviderAccounts,
  {
    /** The accounts now, then each time they change. */
    readonly changes: Stream.Stream<ReadonlyArray<ProviderAccount>>;
    readonly find: (providerId: ProviderId) => Effect.Effect<Option.Option<ProviderAccount>>;
    /**
     * The accounts of `harness` that run J3 Bots' copy of it, or the one on
     * the server's `PATH`: those a change of that copy rebuilds.
     */
    readonly following: (harness: SignInHarness) => Effect.Effect<ReadonlyArray<ProviderId>>;
    /** Adds an account of `harness`, on and signed out, in a new home: its id. */
    readonly add: (input: {
      readonly commandId: CommandId;
      readonly harness: SignInHarness;
      readonly name: string;
    }) => Effect.Effect<ProviderId, CommandError>;
    /** `NotFound("provider")` for an account the server does not have. */
    readonly setUp: (input: {
      readonly commandId: CommandId;
      readonly providerId: ProviderId;
      readonly changes: AccountChanges;
    }) => Effect.Effect<void, CommandError>;
    /**
     * Removes an account the operator added, with its home and the sign-in in
     * it. `Conflict("provider-not-removable")` for the first of a harness.
     */
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly providerId: ProviderId;
    }) => Effect.Effect<void, CommandError>;
  }
>()("@j3-bots/server/providers/Accounts/ProviderAccounts") {}

/**
 * `status` with what the operator can set up of each account
 * (`ProviderStatus.setup`), for the providers the engine reports.
 */
export const withAccounts = (
  status: EngineStatus,
  accounts: ReadonlyArray<ProviderAccount>,
  home: (providerId: ProviderId) => string,
): EngineStatus => ({
  ...status,
  providers: status.providers.map((provider) => {
    const account = accounts.find((candidate) => candidate.id === provider.id);
    if (account === undefined) return provider;
    return {
      ...provider,
      name: account.name,
      setup: {
        enabled: account.enabled,
        added: account.added,
        binaryPath: account.binaryPath,
        launchArguments: account.launchArguments,
        home: home(account.id),
      },
    };
  }),
});

export const layer = Layer.effect(
  ProviderAccounts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const receipts = yield* CommandReceipts;
    const ids = yield* Ids;
    const engine = yield* Engine;
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { providerHome } = homeLayout(path, config.home);
    const providersFolder = path.dirname(providerHome("_"));
    const accounts = yield* SubscriptionRef.make(yield* readAccounts);

    /**
     * Removes each folder in `providers` that is no account's home, as the
     * home of one removed, and only through J3 Bots' own folders: one a link
     * leads elsewhere is left, with what it leads to, which is not J3 Bots'.
     */
    const removeStrayHomes = Effect.gen(function* () {
      if (!(yield* fs.exists(providersFolder))) return;
      const kept = new Set<string>(
        (yield* SubscriptionRef.get(accounts)).map((account) => account.id),
      );
      const realProviders = yield* fs.realPath(providersFolder);
      if (
        realProviders !== path.join(yield* fs.realPath(config.home), path.basename(providersFolder))
      ) {
        return yield* Effect.logWarning("The AI accounts' folder leads out of J3 Bots' folder");
      }
      for (const name of yield* fs.readDirectory(providersFolder)) {
        if (kept.has(name)) continue;
        const folder = path.join(providersFolder, name);
        if ((yield* fs.realPath(folder)) !== path.join(realProviders, name)) {
          yield* Effect.logWarning(
            "A removed AI account's folder leads elsewhere, so it is kept",
          ).pipe(Effect.annotateLogs({ folder: name }));
          continue;
        }
        yield* fs.remove(folder, { recursive: true, force: true });
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("A removed AI account's folder could not be removed", cause),
      ),
    );
    // A removal the engine had not taken when the server stopped left its home.
    yield* removeStrayHomes;
    // One change at a time, so the engine is given the accounts in the order they were saved.
    const lock = yield* Semaphore.make(1);

    /** Reads what was saved, then has the engine run it: whether it took every change now. */
    const applied = Effect.gen(function* () {
      const now = yield* readAccounts;
      yield* SubscriptionRef.set(accounts, now);
      return yield* engine.setProviders(engineProviders(path, config, now));
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

    const find = (providerId: ProviderId) =>
      Effect.map(SubscriptionRef.get(accounts), (all) =>
        Option.fromNullishOr(all.find((account) => account.id === providerId)),
      );

    const following = (harness: SignInHarness) =>
      Effect.map(SubscriptionRef.get(accounts), (all) =>
        all
          .filter((account) => account.harness === harness && account.binaryPath === null)
          .map((account) => account.id),
      );

    const add = Effect.fn("ProviderAccounts.add")(function* (input: {
      readonly commandId: CommandId;
      readonly harness: SignInHarness;
      readonly name: string;
    }) {
      const { commandId, ...payload } = input;
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const providerId = yield* receipts.once({
            commandId,
            method: "engine.addProvider",
            payload,
            result: ProviderId,
            apply: transaction(
              Effect.gen(function* () {
                const id = ProviderId.make(yield* ids.make(input.harness));
                yield* sql`
                  INSERT INTO provider_accounts (id, harness, name, added, position)
                  SELECT ${id}, ${input.harness}, ${input.name}, 1,
                    COALESCE(MAX(position), -1) + 1
                  FROM provider_accounts
                `;
                return id;
              }),
            ),
          });
          yield* applied;
          return providerId;
        }),
      );
    });

    const setUp = Effect.fn("ProviderAccounts.setUp")(function* (input: {
      readonly commandId: CommandId;
      readonly providerId: ProviderId;
      readonly changes: AccountChanges;
    }) {
      const { commandId, providerId, changes } = input;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* receipts.once({
            commandId,
            method: "engine.setUpProvider",
            payload: { providerId, ...changes },
            result: Schema.Void,
            apply: transaction(
              Effect.gen(function* () {
                const before = yield* find(providerId);
                if (Option.isNone(before)) return yield* new NotFound({ resource: "provider" });
                const next = { ...before.value, ...changes };
                yield* sql`
                  UPDATE provider_accounts SET
                    name = ${next.name},
                    enabled = ${next.enabled ? 1 : 0},
                    binary_path = ${next.binaryPath},
                    launch_arguments = ${next.launchArguments}
                  WHERE id = ${providerId}
                `;
              }),
            ),
          });
          yield* applied;
        }),
      );
    });

    const remove = Effect.fn("ProviderAccounts.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly providerId: ProviderId;
    }) {
      const { commandId, providerId } = input;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* receipts.once({
            commandId,
            method: "engine.removeProvider",
            payload: { providerId },
            result: Schema.Void,
            apply: transaction(
              Effect.gen(function* () {
                const account = yield* find(providerId);
                if (Option.isNone(account)) return yield* new NotFound({ resource: "provider" });
                if (!account.value.added) {
                  return yield* new Conflict({ reason: "provider-not-removable" });
                }
                yield* sql`DELETE FROM provider_accounts WHERE id = ${providerId}`;
              }),
            ),
          });
          // Its home, with the sign-in in it, goes once the engine no longer runs it;
          // until then it stays, and the next start removes it.
          if (yield* applied) yield* removeStrayHomes;
        }),
      );
    });

    return ProviderAccounts.of({
      changes: SubscriptionRef.changes(accounts),
      find,
      following,
      add,
      setUp,
      remove,
    });
  }),
);
