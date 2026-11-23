// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Attachments from "./attachments/Attachments.ts";
import * as DeviceAuth from "./auth/DeviceAuth.ts";
import * as Bots from "./bots/Bots.ts";
import * as BotStore from "./bots/BotStore.ts";
import * as EngineSessions from "./bots/EngineSessions.ts";
import * as Templates from "./bots/Templates.ts";
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
import * as SignIns from "./providers/SignIns.ts";
import * as PushDeliveries from "./push/PushDeliveries.ts";
import * as PushWorker from "./push/PushWorker.ts";
import * as RoomRouting from "./rooms/RoomRouting.ts";
import * as Rooms from "./rooms/Rooms.ts";
import * as Roster from "./roster/Roster.ts";
import * as Sections from "./sections/Sections.ts";
import * as RoutineRunner from "./routines/RoutineRunner.ts";
import * as RoutineRuns from "./routines/RoutineRuns.ts";
import * as Routines from "./routines/Routines.ts";
import * as Scheduler from "./routines/Scheduler.ts";
import * as SettingsService from "./settings/SettingsService.ts";
import * as SettingsStore from "./settings/SettingsStore.ts";
import * as Host from "./system/Host.ts";
import * as BotTools from "./tools/BotTools.ts";
import * as BotStates from "./turns/BotStates.ts";
import * as Cards from "./turns/Cards.ts";
import * as Ledger from "./turns/Ledger.ts";
import * as Observer from "./turns/Observer.ts";
import * as Pipeline from "./turns/Pipeline.ts";
import * as Readiness from "./turns/Readiness.ts";
import * as RoomStates from "./turns/RoomStates.ts";
import * as Rotations from "./turns/Rotations.ts";
import * as RunningWork from "./turns/RunningWork.ts";
import * as Sender from "./turns/Sender.ts";
import * as SendPause from "./turns/SendPause.ts";
import * as SessionGate from "./turns/SessionGate.ts";
import * as Signals from "./turns/Signals.ts";
import * as Speech from "./turns/Speech.ts";
import * as HeldQueues from "./turns/HeldQueues.ts";
import * as Stops from "./turns/Stops.ts";
import * as Turns from "./turns/Turns.ts";
import * as Usage from "./turns/Usage.ts";
import * as Wakes from "./turns/Wakes.ts";
import * as WorkSteps from "./turns/WorkSteps.ts";

/**
 * Every service of the server's domain, over a migrated database, the server's
 * configuration, the filesystem, an `Engine` and a `PushSender`. Which engine
 * and which sender are the caller's: the real ones in `server.ts`, in-memory
 * ones in tests. Building it starts the turn machinery and the push worker,
 * which run for as long as the layer's scope.
 */
export const layer = Layer.mergeAll(BotTools.layer, Turns.layer, PushWorker.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Bots.layer,
      Templates.layer,
      Roster.layer,
      Speech.layer,
      Pipeline.layer,
      Cards.layer,
      Rotations.layer,
      RunningWork.layer,
      RoutineRunner.layer,
      // The machine as the sign-ins see it: the `PATH` the server runs harnesses with.
      SignIns.layer.pipe(Layer.provide(Host.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Memory.layer,
      Rooms.layer,
      Sections.layer,
      RoomRouting.layer,
      EngineSessions.layer,
      SettingsService.layer,
      Routines.layer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(Workspaces.layer, Stops.roomWorkLayer, Scheduler.layer)),
  Layer.provideMerge(RoutineRuns.layer),
  Layer.provideMerge(Layer.mergeAll(Stops.layer, HeldQueues.layer)),
  Layer.provideMerge(Sender.layer),
  Layer.provideMerge(Observer.layer),
  Layer.provideMerge(Layer.mergeAll(Ledger.layer, Wakes.layer, WorkSteps.layer)),
  Layer.provideMerge(
    Layer.mergeAll(MemoryFiles.layer, Entries.layer, Attachments.layer, BotStore.layer),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BotStates.layer, RoomStates.layer, Presence.layer, PushDeliveries.layer),
  ),
  Layer.provideMerge(Devices.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Ids.layer,
      Layout.layer,
      ChangeLog.layer,
      CommandReceipts.layer,
      SettingsStore.layer,
      EngineState.layer,
      Usage.layer,
      Signals.layer,
      SessionGate.layer,
      SendPause.layer,
      Readiness.layer,
      DeviceAuth.layer,
    ),
  ),
);
