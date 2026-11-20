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
import * as Rooms from "./rooms/Rooms.ts";
import * as RoomWork from "./rooms/RoomWork.ts";
import * as Roster from "./roster/Roster.ts";
import * as Routines from "./routines/Routines.ts";
import * as SettingsService from "./settings/SettingsService.ts";
import * as SettingsStore from "./settings/SettingsStore.ts";
import * as BotTools from "./tools/BotTools.ts";
import * as TurnTools from "./tools/TurnTools.ts";

/**
 * Every service of the server's domain, over a migrated database, the server's
 * configuration, the filesystem and an `Engine`. Which engine is the caller's:
 * the real one in `server.ts`, the in-memory one in tests.
 */
export const layer = Layer.mergeAll(BotTools.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Bots.layer, Roster.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      Memory.layer,
      Rooms.layer,
      EngineSessions.layer,
      SettingsService.layer,
      Routines.layer,
    ),
  ),
  Layer.provideMerge(Workspaces.layer),
  Layer.provideMerge(
    Layer.mergeAll(MemoryFiles.layer, Entries.layer, Attachments.layer, Devices.layer),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Ids.layer,
      Layout.layer,
      ChangeLog.layer,
      CommandReceipts.layer,
      SettingsStore.layer,
      BotStore.layer,
      EngineState.layer,
      RoomWork.layer,
      TurnTools.layer,
      DeviceAuth.layer,
    ),
  ),
);
