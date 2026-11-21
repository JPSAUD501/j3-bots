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
import { Presence } from "../presence/Presence.ts";
import { Cards } from "../turns/Cards.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { Stops } from "../turns/Stops.ts";
import { Usage } from "../turns/Usage.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";

/** The RPCs this server answers: every one of `J3Rpcs`. */
export const ServedRpcs = J3Rpcs;

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
    const pipeline = yield* Pipeline;
    const cards = yield* Cards;
    const stops = yield* Stops;
    const workSteps = yield* WorkSteps;
    const usage = yield* Usage;
    const viewer = yield* (yield* Presence).connect;

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
      "entries.workSteps": ({ entryId }) => workSteps.follow(entryId),
      "message.send": (input) => pipeline.sendMessage(input),
      "message.retry": (input) => pipeline.retryMessage(input),
      "notice.retry": (input) => pipeline.retryNotice(input),
      "card.answer": (input) => cards.answer(input),
      "secret.provide": (input) => cards.provideSecret(input),
      "bot.stop": (input) => stops.stopBot(input),
      "bot.create": ({ commandId, ...draft }) => bots.create({ commandId, draft }),
      "bot.update": ({ commandId, botId, ...changes }) =>
        bots.update({ commandId, botId, changes }),
      "bot.delete": (input) => bots.remove(input),
      "bot.freshStart": (input) => bots.freshStart(input),
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
      "routine.run": (input) => routines.run(input),
      "memory.list": ({ scope }) => memory.list(scope),
      "memory.read": ({ scope, path }) => memory.read(scope, path),
      "memory.write": (input) => memory.write(input),
      "engine.subscribe": () => engine.status,
      "usage.turns": (input) => usage.turns(input),
      "settings.get": () => settings.get,
      "settings.update": ({ commandId, ...changes }) => settings.update({ commandId, changes }),
      "client.view": ({ target }) => viewer.view(target),
      "notifications.subscribe": () => viewer.notifications,
      "devices.list": () => devices.list(device.id),
      "pairing.start": () => devices.startPairing,
      // Revoking is idempotent by nature: a retry revokes nothing more.
      "device.revoke": ({ deviceId }) => auth.revoke(deviceId),
    };
  }),
);
