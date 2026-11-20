// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Budgets,
  type CommandError,
  type CommandId,
  Invalid,
  type NotificationSettings,
  Settings,
  type TimeZone,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Workspaces } from "../bots/Workspaces.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { SettingsStore } from "./SettingsStore.ts";

/** The changes `settings.update` may ask for. */
export interface SettingsChanges {
  readonly operatorName?: string | null;
  readonly timeZone?: TimeZone;
  readonly budgets?: Budgets;
  readonly notifications?: NotificationSettings;
}

/**
 * The operator's settings. The operator's name and time zone are part of every
 * bot's instructions, so a change to either rewrites them all.
 */
export class SettingsService extends Context.Service<
  SettingsService,
  {
    readonly get: Effect.Effect<Settings>;
    /** Fails with `Invalid("time-zone")` for a time zone that does not exist. */
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly changes: SettingsChanges;
    }) => Effect.Effect<Settings, CommandError>;
  }
>()("@j3-bots/server/settings/SettingsService") {}

export const layer = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const receipts = yield* CommandReceipts;
    const workspaces = yield* Workspaces;

    const update = Effect.fn("SettingsService.update")(function* (input: {
      readonly commandId: CommandId;
      readonly changes: SettingsChanges;
    }) {
      const { changes } = input;
      if (
        changes.timeZone !== undefined &&
        Option.isNone(DateTime.zoneMakeNamed(changes.timeZone))
      ) {
        return yield* new Invalid({ reason: "time-zone" });
      }
      const saved = yield* receipts.once({
        commandId: input.commandId,
        method: "settings.update",
        payload: changes,
        result: Settings,
        apply: Effect.gen(function* () {
          const current = yield* store.get;
          const next: Settings = {
            operatorName:
              changes.operatorName === undefined ? current.operatorName : changes.operatorName,
            timeZone: changes.timeZone ?? current.timeZone,
            budgets: changes.budgets ?? current.budgets,
            notifications: changes.notifications ?? current.notifications,
          };
          yield* store.save(next, yield* DateTime.now);
          return next;
        }),
      });
      if (changes.operatorName !== undefined || changes.timeZone !== undefined) {
        yield* workspaces.renderAll;
      }
      return saved;
    });

    return SettingsService.of({ get: store.get, update });
  }),
);
