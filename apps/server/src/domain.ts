// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Layer from "effect/Layer";
import * as Attachments from "./attachments/Attachments.ts";
import * as DeviceAuth from "./auth/DeviceAuth.ts";
import * as Bots from "./bots/Bots.ts";
import * as BotStore from "./bots/BotStore.ts";
import * as EngineSessions from "./bots/EngineSessions.ts";
import * as Workspaces from "./bots/Workspaces.ts";
import * as CommandReceipts from "./commands/CommandReceipts.ts";
import * as Devices from "./devices/Devices.ts";
import * as EngineState from "./engine/EngineState.ts";
import * as Entries from "./entries/Entries.ts";
import * as Ids from "./Ids.ts";
import * as Layout from "./Layout.ts";
import * as Memory from "./memory/Memory.ts";
import * as MemoryFiles from "./memory/MemoryFiles.ts";
import * as ChangeLog from "./persistence/ChangeLog.ts";
import * as Presence from "./presence/Presence.ts";
import * as RoomRouting from "./rooms/RoomRouting.ts";
import * as Rooms from "./rooms/Rooms.ts";
import * as Roster from "./roster/Roster.ts";
import * as Routines from "./routines/Routines.ts";
import * as SettingsService from "./settings/SettingsService.ts";
import * as SettingsStore from "./settings/SettingsStore.ts";
import * as BotTools from "./tools/BotTools.ts";
import * as BotStates from "./turns/BotStates.ts";
import * as Cards from "./turns/Cards.ts";
import * as Ledger from "./turns/Ledger.ts";
import * as Observer from "./turns/Observer.ts";
import * as Pipeline from "./turns/Pipeline.ts";
import * as Readiness from "./turns/Readiness.ts";
import * as Sender from "./turns/Sender.ts";
import * as SessionGate from "./turns/SessionGate.ts";
import * as Signals from "./turns/Signals.ts";
import * as Speech from "./turns/Speech.ts";
import * as HeldQueues from "./turns/HeldQueues.ts";
import * as Stops from "./turns/Stops.ts";
import * as Turns from "./turns/Turns.ts";
import * as Wakes from "./turns/Wakes.ts";
import * as WorkSteps from "./turns/WorkSteps.ts";

/**
 * Every service of the server's domain, over a migrated database, the server's
 * configuration, the filesystem and an `Engine`. Which engine is the caller's:
 * the real one in `server.ts`, the in-memory one in tests. Building it starts
 * the turn machinery, which runs for as long as the layer's scope.
 */
export const layer = Layer.mergeAll(BotTools.layer, Turns.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(Bots.layer, Roster.layer, Speech.layer, Pipeline.layer, Cards.layer),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Memory.layer,
      Rooms.layer,
      EngineSessions.layer,
      SettingsService.layer,
      Routines.layer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(Workspaces.layer, Stops.roomWorkLayer)),
  Layer.provideMerge(Layer.mergeAll(Stops.layer, HeldQueues.layer)),
  Layer.provideMerge(Sender.layer),
  Layer.provideMerge(Observer.layer),
  Layer.provideMerge(Layer.mergeAll(Ledger.layer, Wakes.layer, WorkSteps.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      MemoryFiles.layer,
      Entries.layer,
      Attachments.layer,
      Devices.layer,
      BotStore.layer,
    ),
  ),
  Layer.provideMerge(BotStates.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Ids.layer,
      Layout.layer,
      ChangeLog.layer,
      CommandReceipts.layer,
      SettingsStore.layer,
      EngineState.layer,
      RoomRouting.layer,
      Presence.layer,
      Signals.layer,
      SessionGate.layer,
      Readiness.layer,
      DeviceAuth.layer,
    ),
  ),
);
