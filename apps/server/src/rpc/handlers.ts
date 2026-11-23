// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AttachmentId,
  type BotId,
  type Entry,
  J3Rpcs,
  NotFound,
  USAGE_PERIOD,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import { Attachments } from "../attachments/Attachments.ts";
import { CurrentDevice, DeviceAuth } from "../auth/DeviceAuth.ts";
import { ConnectorAuth } from "../connectors/oauth/ConnectorAuth.ts";
import { toCommandError } from "../connectors/oauth/errors.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Bots } from "../bots/Bots.ts";
import { Templates } from "../bots/Templates.ts";
import { Devices } from "../devices/Devices.ts";
import { Entries, type EntryFrame } from "../entries/Entries.ts";
import { ServerConfig } from "../config.ts";
import { ConnectorSources } from "../connectors/sources/Sources.ts";
import { Listener } from "../listener.ts";
import { Memory } from "../memory/Memory.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import { Roster } from "../roster/Roster.ts";
import { Sections } from "../sections/Sections.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { Presence } from "../presence/Presence.ts";
import { connectProviders } from "../providers/connect.ts";
import { SignIns } from "../providers/SignIns.ts";
import { Network, reachableOrigins } from "../system/Network.ts";
import { Cards } from "../turns/Cards.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import { Stops } from "../turns/Stops.ts";
import { Usage } from "../turns/Usage.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { Vault } from "../vault/Vault.ts";

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
    const templates = yield* Templates;
    const attachments = yield* Attachments;
    const rooms = yield* Rooms;
    const sections = yield* Sections;
    const routines = yield* Routines;
    const memory = yield* Memory;
    const settings = yield* SettingsService;
    const devices = yield* Devices;
    const pipeline = yield* Pipeline;
    const cards = yield* Cards;
    const stops = yield* Stops;
    const workSteps = yield* WorkSteps;
    const usage = yield* Usage;
    const viewer = yield* (yield* Presence).connect(device.id);
    const listener = yield* Listener;
    const network = yield* Network;
    const { publicOrigin } = yield* ServerConfig;
    const signIns = yield* SignIns;
    const vault = yield* Vault;
    const connectors = yield* Connectors;
    const connectorAuth = yield* ConnectorAuth;
    const connectorSources = yield* ConnectorSources;
    const connectContext = yield* Effect.context<Engine | RunningWork | SendPause>();

    /**
     * A code, and the origins `j3-bots pair` lists, read when asked since
     * interfaces come and go. A client reached the server through the
     * listener, so it has bound.
     */
    const startPairing = Effect.gen(function* () {
      const grant = yield* devices.startPairing;
      const origins = yield* reachableOrigins(yield* Deferred.await(listener), publicOrigin).pipe(
        Effect.provideService(Network, network),
      );
      return { ...grant, origins };
    });

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
      // Typed to answer only an `Entry`: the contract takes any `ReceivedEntry`,
      // but the server never sends a kind it does not know.
      "entries.subscribe": ({ target, after }): Stream.Stream<EntryFrame, NotFound> =>
        entries.subscribe(target, after),
      "entries.history": (
        input,
      ): Effect.Effect<
        { readonly entries: ReadonlyArray<Entry>; readonly hasOlder: boolean },
        NotFound
      > => entries.history(input),
      "entries.markRead": ({ target, through }) => entries.markRead(target, through),
      "entries.markUnread": (input) => entries.markUnread(input),
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
      "bot.template": ({ botId }) => templates.template(botId),
      "bot.createFromTemplate": ({ commandId, ...from }) =>
        bots.createFromTemplate({ commandId, from }),
      "section.create": (input) => sections.create(input),
      "section.update": (input) => sections.update(input),
      "section.delete": (input) => sections.remove(input),
      "room.create": (input) => rooms.create(input),
      "room.update": ({ commandId, roomId, ...changes }) =>
        rooms.update({ commandId, roomId, changes }),
      "room.delete": (input) => rooms.remove(input),
      "room.stop": (input) => rooms.stop(input),
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
      "usage.turns": ({ limit }) => usage.turns({ period: USAGE_PERIOD, limit }),
      "settings.get": () => settings.get,
      "settings.subscribe": () => settings.changes,
      "settings.update": ({ commandId, ...changes }) => settings.update({ commandId, changes }),
      "settings.deviceTimeZone": ({ timeZone }) => settings.deviceTimeZone(timeZone),
      "client.view": ({ target }) => viewer.view(target),
      "notifications.subscribe": () => viewer.notifications,
      "devices.list": () => devices.list(device.id),
      "pairing.start": () => startPairing,
      // Revoking is idempotent by nature: a retry revokes nothing more.
      "device.revoke": ({ deviceId }) => auth.revoke(deviceId),
      // Always this socket's own device: a device registers only itself.
      "push.register": ({ commandId, ...registration }) =>
        devices.registerPush({ commandId, deviceId: device.id, registration }),
      "push.unregister": ({ commandId }) =>
        devices.unregisterPush({ commandId, deviceId: device.id }),
      "provider.harnesses": () => signIns.locations,
      "provider.signIn": ({ harness, start }) => signIns.follow(harness, start),
      "provider.cancelSignIn": ({ harness }) => signIns.cancel(harness),
      // The request carries the key: it is never logged, and has no receipt.
      "provider.connect": (request) =>
        connectProviders(request).pipe(Effect.provideContext(connectContext)),
      // The vault's requests carry or answer values: none is logged, and none has a receipt.
      "vault.status": () => vault.status,
      "vault.setup": ({ password }) => vault.setup(password),
      "vault.unlock": ({ password }) => vault.unlock(password),
      "vault.lock": () => vault.lock,
      "vault.changePassword": ({ current, next }) => vault.changePassword(current, next),
      "vault.list": () => vault.list,
      "vault.reveal": ({ id, field }) => vault.reveal({ id, field, deviceId: device.id }),
      "vault.save": ({ id, allowedBots, request, ...draft }) =>
        cards.saveCredential({ id, draft, allowedBots, request }),
      "vault.update": ({ id, ...changes }) => vault.update({ id, changes }),
      "vault.delete": ({ id }) => vault.remove(id),
      "vault.setAllowedBots": ({ id, bots }) => vault.setAllowedBots(id, bots),
      "vault.totpPreview": ({ id }) => vault.totpPreview(id),
      // A connector's add and update carry its secrets, redacted: none is logged, and neither has a receipt.
      "connectors.subscribe": () => connectors.subscribe,
      "connector.add": (input) => connectors.add(input),
      "connector.update": (input) => connectors.update(input),
      "connector.remove": (input) => connectors.remove(input),
      "connector.setBots": (input) => connectors.setBots(input),
      "connector.acceptToolChanges": (input) => connectors.acceptToolChanges(input),
      // A sign-in's address and the one it returns to carry its code and
      // `state`: neither is logged, and neither request has a receipt.
      "connector.beginSignIn": ({ connectorId, redirect }) =>
        connectorAuth.begin({ connectorId, deviceId: device.id, redirect }).pipe(
          Effect.map(({ authorizationUrl, expiresAt }) => ({
            authorizationUrl: Redacted.make(authorizationUrl),
            expiresAt,
          })),
          Effect.mapError(toCommandError),
        ),
      "connector.completeSignIn": ({ url }) =>
        connectorAuth
          .complete({ _tag: "device", deviceId: device.id, url })
          .pipe(Effect.asVoid, Effect.mapError(toCommandError)),
      "connectors.list": ({ language }) => Effect.succeed(connectorSources.list(language)),
      "connectors.search": (input) => connectorSources.search(input),
      // The page names where an own app's sign-ins return, as `begin` would send them.
      "connectors.get": Effect.fn("connectors.get")(function* ({ ref, language }) {
        const details = yield* connectorSources.get(ref, language);
        const issuer = details.setup?.issuer ?? null;
        const redirects = issuer === null ? null : yield* connectorAuth.redirectsFor(issuer);
        return { ...details, redirects };
      }),
    };
  }),
);
