// SPDX-License-Identifier: AGPL-3.0-or-later
import { type AttachmentId, type BotId, J3Rpcs, NotFound } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Attachments } from "../attachments/Attachments.ts";
import { CurrentDevice, DeviceAuth } from "../auth/DeviceAuth.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import { Entries } from "../entries/Entries.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import { Roster } from "../roster/Roster.ts";
import { SettingsService } from "../settings/SettingsService.ts";

/**
 * The RPCs this server answers: `J3Rpcs` without those that start, steer or
 * stop a turn, answer what a turn holds on, or follow one. They come with the
 * wake pipeline. Until then a client's call to one fails as any unknown RPC does.
 */
export const ServedRpcs = J3Rpcs.omit(
  "message.send",
  "card.answer",
  "secret.provide",
  "notice.retry",
  "message.retry",
  "bot.stop",
  "bot.freshStart",
  "routine.run",
  "entries.workSteps",
  "client.view",
  "notifications.subscribe",
  "usage.turns",
);

const operator = { _tag: "operator" } as const;

/** One socket's handlers, acting as the device the socket belongs to. */
export const handlers = ServedRpcs.toLayer(
  Effect.gen(function* () {
    const device = yield* CurrentDevice;
    const auth = yield* DeviceAuth;
    const engine = yield* Engine;
    const roster = yield* Roster;
    const entries = yield* Entries;
    const store = yield* BotStore;
    const bots = yield* Bots;
    const attachments = yield* Attachments;
    const rooms = yield* Rooms;
    const routines = yield* Routines;
    const memory = yield* Memory;
    const settings = yield* SettingsService;
    const devices = yield* Devices;

    const botFiles = Effect.fn("rpc.botFiles")(function* (input: {
      readonly botId: BotId;
      readonly before: AttachmentId | null;
      readonly limit: number;
    }) {
      if (Option.isNone(yield* store.find(input.botId))) {
        return yield* new NotFound({ resource: "bot" });
      }
      return yield* attachments.botFiles(input);
    });

    return {
      "roster.subscribe": () => roster.subscribe,
      "entries.subscribe": ({ target, after }) => entries.subscribe(target, after),
      "entries.history": (input) => entries.history(input),
      "entries.markRead": ({ target, through }) => entries.markRead(target, through),
      "bot.create": ({ commandId, ...draft }) => bots.create({ commandId, draft }),
      "bot.update": ({ commandId, botId, ...changes }) =>
        bots.update({ commandId, botId, changes }),
      "bot.delete": (input) => bots.remove(input),
      "bot.files": botFiles,
      "room.create": (input) => rooms.create(input),
      "room.update": ({ commandId, roomId, ...changes }) =>
        rooms.update({ commandId, roomId, changes }),
      "room.delete": (input) => rooms.remove(input),
      "routines.subscribe": ({ botId, after }) => routines.subscribe(botId, after),
      "routine.runs": (input) => routines.runs(input),
      "routine.create": ({ commandId, botId, ...draft }) =>
        routines.create({ commandId, botId, draft, author: operator }),
      "routine.update": ({ commandId, routineId, ...changes }) =>
        routines.update({ commandId, routineId, changes, author: operator }),
      "routine.delete": ({ commandId, routineId }) =>
        routines.remove({ commandId, routineId, author: operator }),
      "memory.list": ({ scope }) => memory.list(scope),
      "memory.read": ({ scope, path }) => memory.read(scope, path),
      "memory.write": (input) => memory.write(input),
      "engine.subscribe": () => engine.status,
      "settings.get": () => settings.get,
      "settings.update": ({ commandId, ...changes }) => settings.update({ commandId, changes }),
      "devices.list": () => devices.list(device.id),
      "pairing.start": () => devices.startPairing,
      // Revoking is idempotent by nature: a retry revokes nothing more.
      "device.revoke": ({ deviceId }) => auth.revoke(deviceId),
    };
  }),
);
