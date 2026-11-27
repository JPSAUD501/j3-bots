// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandError,
  type CommandId,
  Invalid,
  keepsUtcClock,
  Settings,
  type SettingsChange,
  type TimeZone,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Workspaces } from "../bots/Workspaces.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { BasePrompt } from "./BasePrompt.ts";
import { SuggestReplies } from "./SuggestReplies.ts";
import { DEFAULT_VOICE_SETTINGS, SettingsStore } from "./SettingsStore.ts";
import { TelemetrySwitch } from "../telemetry/TelemetrySwitch.ts";

/** The changes `settings.update` may ask for. */
export type SettingsChanges = SettingsChange;

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
    /** The settings now, then each change once it has committed, whoever made it. */
    readonly changes: Stream.Stream<Settings>;
    /** Fails with `Invalid("time-zone")` for a time zone that does not exist. */
    readonly update: (input: {
      readonly commandId: CommandId;
      readonly changes: SettingsChanges;
    }) => Effect.Effect<Settings, CommandError>;
    /**
     * Saves `changes` in the caller's transaction and returns the settings as
     * saved, as `update` does but with no command receipt: for a caller that
     * makes its change act once by its own record, as a bot's tool call does.
     * Once that transaction has committed, the caller runs `applied`.
     */
    readonly save: (changes: SettingsChanges) => Effect.Effect<Settings, Invalid>;
    /**
     * Brings what follows the settings up to saved `changes`: the base
     * prompt, every bot's instructions, and `changes`' subscribers. Safe to
     * run again.
     */
    readonly applied: (changes: SettingsChanges) => Effect.Effect<void>;
    /**
     * A device's time zone, which becomes the operator's unless they chose
     * one or a device gave one before. A zone the server does not know
     * changes nothing, and neither does one that keeps UTC's clock all year:
     * a device that hides its zone, or never had one set, reports that, and
     * it is no better than the UTC the server starts at. An operator who
     * wants UTC chooses it.
     */
    readonly deviceTimeZone: (timeZone: TimeZone) => Effect.Effect<void>;
    /**
     * Runs `effect` with the update channel steady: no change of it under
     * way, and none beginning until `effect` ends. `update` changes the
     * channel under it; a caller that changes it with `save` runs its
     * transaction under it. What starts an update reads the channel's offer
     * and records the run under it, so a change commits before the offer is
     * read or after the run is recorded.
     */
    readonly channelSteady: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@j3-bots/server/settings/SettingsService") {}

export const layer = Layer.effect(
  SettingsService,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const receipts = yield* CommandReceipts;
    const workspaces = yield* Workspaces;
    const basePrompt = yield* BasePrompt;
    const suggestReplies = yield* SuggestReplies;
    const telemetry = yield* TelemetrySwitch;
    const current = yield* SubscriptionRef.make(yield* store.get);
    const channel = yield* Semaphore.make(1);
    const channelSteady = Effect.fn("SettingsService.channelSteady")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* channel.withPermits(1)(effect);
    });

    /**
     * Tells `changes`' subscribers the settings as committed now. The read
     * holds the ref's permit, so of two writes close together the later
     * publish reads, and leaves, the later value.
     */
    const publish = SubscriptionRef.updateEffect(current, () => store.get);

    const save = Effect.fn("SettingsService.save")(function* (changes: SettingsChanges) {
      if (
        changes.timeZone !== undefined &&
        Option.isNone(DateTime.zoneMakeNamed(changes.timeZone))
      ) {
        return yield* new Invalid({ reason: "time-zone" });
      }
      const saved = yield* store.get;
      const next: Settings = {
        operatorName:
          changes.operatorName === undefined ? saved.operatorName : changes.operatorName,
        timeZone: changes.timeZone ?? saved.timeZone,
        budgets: changes.budgets ?? saved.budgets,
        // Field by field, read in the same transaction as the write.
        notifications: { ...saved.notifications, ...changes.notifications },
        updateChannel: changes.updateChannel ?? saved.updateChannel,
        autoUpdateHarnesses: changes.autoUpdateHarnesses ?? saved.autoUpdateHarnesses,
        suggestReplies: changes.suggestReplies ?? saved.suggestReplies,
        // Field by field too, so a device that changes one leaves the rest.
        voice: { ...(saved.voice ?? DEFAULT_VOICE_SETTINGS), ...changes.voice },
        ...(saved.telemetry === undefined
          ? {}
          : {
              telemetry: {
                enabled: changes.telemetry ?? saved.telemetry.enabled,
                heldOff: saved.telemetry.heldOff,
              },
            }),
      };
      yield* store.save(next, yield* DateTime.now, { zoneChosen: changes.timeZone !== undefined });
      return next;
    });

    const applied = Effect.fn("SettingsService.applied")(function* (changes: SettingsChanges) {
      if (changes.operatorName !== undefined) yield* basePrompt.refresh;
      if (changes.suggestReplies !== undefined) yield* suggestReplies.refresh;
      // At once: what waits to be sent is dropped as it turns off.
      if (changes.telemetry !== undefined) yield* telemetry.refresh;
      if (changes.operatorName !== undefined || changes.timeZone !== undefined) {
        yield* workspaces.renderAll;
      }
      yield* publish;
    });

    const update = Effect.fn("SettingsService.update")(function* (input: {
      readonly commandId: CommandId;
      readonly changes: SettingsChanges;
    }) {
      const change = Effect.gen(function* () {
        const saved = yield* receipts.once({
          commandId: input.commandId,
          method: "settings.update",
          payload: input.changes,
          result: Settings,
          apply: save(input.changes),
        });
        yield* applied(input.changes);
        return saved;
      });
      return yield* input.changes.updateChannel === undefined ? change : channelSteady(change);
    });

    const deviceTimeZone = Effect.fn("SettingsService.deviceTimeZone")(function* (
      timeZone: TimeZone,
    ) {
      if (Option.isNone(DateTime.zoneMakeNamed(timeZone))) return;
      const now = yield* DateTime.now;
      if (keepsUtcClock(timeZone, DateTime.toPartsUtc(now).year)) return;
      if (yield* store.adoptTimeZone(timeZone, now)) {
        yield* workspaces.renderAll;
        yield* publish;
      }
    });

    return SettingsService.of({
      get: store.get,
      changes: SubscriptionRef.changes(current),
      update,
      save,
      applied,
      deviceTimeZone,
      channelSteady,
    });
  }),
);
