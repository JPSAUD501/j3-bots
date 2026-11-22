// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Budgets,
  type CommandError,
  type CommandId,
  Invalid,
  NotificationSettings,
  type NotificationSettingsChange,
  Settings,
  type TimeZone,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Workspaces } from "../bots/Workspaces.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { BasePrompt } from "./BasePrompt.ts";
import { SettingsStore } from "./SettingsStore.ts";

/** The changes `settings.update` may ask for. */
export interface SettingsChanges {
  readonly operatorName?: string | null;
  readonly timeZone?: TimeZone;
  readonly budgets?: Budgets;
  readonly notifications?: NotificationSettingsChange;
}

/**
 * The settings a `settings.update` receipt holds. A receipt written before
 * notifications could be turned off has no `enabled`: they were on.
 */
const SettingsReceipt = Schema.Struct({
  ...Settings.fields,
  notifications: Schema.Struct({
    ...NotificationSettings.fields,
    enabled: NotificationSettings.fields.enabled.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(true)),
    ),
  }),
});

/**
 * The operator's settings. The operator's name and time zone are part of every
 * bot's instructions, so a change to either rewrites them all; the name is also
 * in the base prompt the engine gives Codex.
 *
 * The time zone is the operator's device's until they choose one: the server
 * starts at UTC, and the first device that gives its zone sets it. Later
 * devices change nothing, so one in another zone, or a laptop that travels,
 * never moves the routines' clock without the operator.
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
    /**
     * A device's time zone, which becomes the operator's unless they chose
     * one or a device gave one before. A zone the server does not know
     * changes nothing.
     */
    readonly deviceTimeZone: (timeZone: TimeZone) => Effect.Effect<void>;
  }
>()("@j3-bots/server/settings/SettingsService") {}

export const layer = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const receipts = yield* CommandReceipts;
    const workspaces = yield* Workspaces;
    const basePrompt = yield* BasePrompt;

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
        result: SettingsReceipt,
        apply: Effect.gen(function* () {
          const current = yield* store.get;
          const next: Settings = {
            operatorName:
              changes.operatorName === undefined ? current.operatorName : changes.operatorName,
            timeZone: changes.timeZone ?? current.timeZone,
            budgets: changes.budgets ?? current.budgets,
            // Field by field, read in the same transaction as the write.
            notifications: { ...current.notifications, ...changes.notifications },
          };
          yield* store.save(next, yield* DateTime.now, {
            zoneChosen: changes.timeZone !== undefined,
          });
          return next;
        }),
      });
      if (changes.operatorName !== undefined) yield* basePrompt.refresh;
      if (changes.operatorName !== undefined || changes.timeZone !== undefined) {
        yield* workspaces.renderAll;
      }
      return saved;
    });

    const deviceTimeZone = Effect.fn("SettingsService.deviceTimeZone")(function* (
      timeZone: TimeZone,
    ) {
      if (Option.isNone(DateTime.zoneMakeNamed(timeZone))) return;
      if (yield* store.adoptTimeZone(timeZone, yield* DateTime.now)) yield* workspaces.renderAll;
    });

    return SettingsService.of({ get: store.get, update, deviceTimeZone });
  }),
);
