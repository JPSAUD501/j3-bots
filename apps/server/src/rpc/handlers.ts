// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AttachmentId,
  type BotId,
  Conflict,
  type Entry,
  Invalid,
  J3Rpcs,
  NotFound,
  type ProviderId,
  USAGE_PERIOD,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Attachments } from "../attachments/Attachments.ts";
import { CurrentDevice, DeviceAuth } from "../auth/DeviceAuth.ts";
import { ConnectorAuth } from "../connectors/oauth/ConnectorAuth.ts";
import { toCommandError } from "../connectors/oauth/errors.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BrowserHelp } from "../browser/BrowserHelp.ts";
import { BrowserTabs } from "../browser/BrowserTabs.ts";
import { Bots } from "../bots/Bots.ts";
import { Templates } from "../bots/Templates.ts";
import { Devices } from "../devices/Devices.ts";
import { Entries, type EntryFrame } from "../entries/Entries.ts";
import { ServerConfig } from "../config.ts";
import { ConnectorSources } from "../connectors/sources/Sources.ts";
import { Listener } from "../listener.ts";
import { Memory } from "../memory/Memory.ts";
import { Pairs } from "../pairs/Pairs.ts";
import { Rooms } from "../rooms/Rooms.ts";
import { Routines } from "../routines/Routines.ts";
import { Roster } from "../roster/Roster.ts";
import { Sections } from "../sections/Sections.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { Presence } from "../presence/Presence.ts";
import { connectProviders } from "../providers/connect.ts";
import { SignIns } from "../providers/SignIns.ts";
import { Harnesses, withCopies } from "../harnesses/Harnesses.ts";
import { Network, reachableOrigins } from "../system/Network.ts";
import { Cards } from "../turns/Cards.ts";
import { Reactions } from "../reactions/Reactions.ts";
import { Pipeline } from "../turns/Pipeline.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import { Stops } from "../turns/Stops.ts";
import { Usage } from "../turns/Usage.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { ConnectorApps } from "../connectors/ConnectorApps.ts";
import { Connectors } from "../connectors/Connectors.ts";
import { SecretAsks } from "../secrets/SecretAsks.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { Skills } from "../skills/Skills.ts";
import { ConnectorInputs } from "../connectors/ConnectorInputs.ts";
import { Management } from "../tools/Management.ts";

const operator = { _tag: "operator" } as const;

/** One socket's handlers, acting as the device the socket belongs to. */
export const handlers = J3Rpcs.toLayer(
  Effect.gen(function* () {
    const device = yield* CurrentDevice;
    const auth = yield* DeviceAuth;
    const engine = yield* Engine;
    const roster = yield* Roster;
    const pairs = yield* Pairs;
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
    const skills = yield* Skills;
    const pipeline = yield* Pipeline;
    const reactions = yield* Reactions;
    const cards = yield* Cards;
    const browserHelp = yield* BrowserHelp;
    const stops = yield* Stops;
    const workSteps = yield* WorkSteps;
    const usage = yield* Usage;
    const viewer = yield* (yield* Presence).connect(device.id);
    const listener = yield* Listener;
    const network = yield* Network;
    const { publicOrigin } = yield* ServerConfig;
    const signIns = yield* SignIns;
    const harnesses = yield* Harnesses;
    /** The engine's status as clients get it: each provider with its harness's copy. */
    const served = Stream.zipLatestWith(engine.status, harnesses.copies, withCopies);
    const browserTabs = yield* BrowserTabs;
    const secrets = yield* Secrets;
    const secretAsks = yield* SecretAsks;
    const connectors = yield* Connectors;
    const connectorInputs = yield* ConnectorInputs;
    const management = yield* Management;
    const connectorApps = yield* ConnectorApps;
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

    /**
     * The engine's check of a provider it reports, run again now. Until the
     * engine is ready it reports none, so the request waits for nothing: the
     * engine cannot take it.
     */
    const recheckProvider = Effect.fn("rpc.recheckProvider")(function* (providerId: ProviderId) {
      const status = yield* Stream.runHead(engine.status);
      if (Option.isNone(status) || status.value.state._tag !== "ready") {
        return yield* new Conflict({ reason: "engine-unavailable" });
      }
      if (!status.value.providers.some((provider) => provider.id === providerId)) {
        return yield* new NotFound({ resource: "provider" });
      }
      yield* engine
        .recheckProvider(providerId)
        .pipe(Effect.mapError(() => new Conflict({ reason: "engine-unavailable" })));
    });

    /**
     * The engine's update of a provider's harness, for one whose version the
     * engine can update: never J3 Bots' own copy, whose status carries no
     * version (`withCopies`). Refused, as `recheckProvider`, until the engine
     * is ready.
     */
    const updateProvider = Effect.fn("rpc.updateProvider")(function* (providerId: ProviderId) {
      const status = yield* Stream.runHead(served);
      if (Option.isNone(status) || status.value.state._tag !== "ready") {
        return yield* new Conflict({ reason: "engine-unavailable" });
      }
      const provider = status.value.providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        return yield* new NotFound({ resource: "provider" });
      }
      if (provider.version?.canUpdate !== true) {
        return yield* new Conflict({ reason: "provider-not-updatable" });
      }
      yield* engine
        .updateProvider(providerId)
        .pipe(Effect.mapError(() => new Conflict({ reason: "engine-unavailable" })));
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
      "pairs.subscribe": () => pairs.subscribe,
      "pairs.history": ({ botIds, before, limit }) =>
        pairs.history({ botIds, before: before ?? null, limit }),
      "pairs.messages.subscribe": ({ botIds }) => pairs.messages(botIds),
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
      "message.react": (input) => reactions.react(input),
      "notice.retry": (input) => pipeline.retryNotice(input),
      // Help in the bot's browser is J3 Bots' own card, apart from the engine's requests.
      "card.answer": ({ answer, ...card }) => {
        switch (answer._tag) {
          case "browser-help":
            return browserHelp.answer({ ...card, outcome: answer.outcome });
          // A connector's request goes back to its server only, never to the engine.
          case "connector-input":
            return connectorInputs.answer({ ...card, answer: answer.answer });
          // The operator's yes adds what the bot asked for; their app's
          // secret goes to the server's secrets alone, never to a receipt.
          case "connector-ask":
            return management.answerAsk({ entryId: card.entryId, client: answer.client });
          default:
            return cards.answer({ ...card, answer });
        }
      },
      "secret.provide": (input) => cards.provideSecret(input),
      "bot.stop": (input) => stops.stopBot(input),
      "bot.forceStop": (input) => stops.forceStopBot(input),
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
      "room.forceStop": (input) => rooms.forceStop(input),
      "routines.subscribe": ({ botId, after, withEvents }) =>
        routines.subscribe(botId, after, withEvents ?? false),
      "routine.runs": (input) => routines.runs(input),
      "routine.create": ({ commandId, botId, ...draft }) =>
        routines.create({ commandId, botId, draft, author: operator }),
      "routine.update": ({ commandId, routineId, ...changes }) =>
        routines.update({ commandId, routineId, changes, author: operator }),
      "routine.delete": ({ commandId, routineId }) =>
        routines.remove({ commandId, routineId, author: operator }),
      "routine.run": (input) => routines.run(input),
      "routine.answer": (input) => routines.answer(input),
      "routine.retry": (input) => routines.retry(input),
      "routine.stopRun": (input) => routines.stopRun(input),
      "memory.list": ({ scope }) => memory.list(scope),
      "memory.read": ({ scope, path }) => memory.read(scope, path),
      "memory.write": (input) => memory.write(input),
      "engine.subscribe": () => served,
      // Checking again checks nothing more: no receipt.
      "engine.recheckProvider": ({ providerId }) => recheckProvider(providerId),
      "engine.updateProvider": ({ providerId }) => updateProvider(providerId),
      "usage.turns": ({ limit }) => usage.turns({ period: USAGE_PERIOD, limit }),
      "settings.get": () => settings.get,
      "settings.subscribe": () => settings.changes,
      "settings.update": ({ commandId, ...changes }) => settings.update({ commandId, changes }),
      "settings.deviceTimeZone": ({ timeZone }) => settings.deviceTimeZone(timeZone),
      // Clearing again clears nothing more: no receipt.
      "browser.signOut": () =>
        engine.clearBrowserProfile.pipe(
          Effect.mapError(() => new Conflict({ reason: "engine-unavailable" })),
        ),
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
      // Installing again while one runs starts nothing more: no receipt.
      "provider.installHarness": ({ harness }) => harnesses.install(harness),
      "provider.cancelHarnessInstall": ({ harness }) => harnesses.cancel(harness),
      // The request carries the key: it is never logged, and has no receipt.
      "provider.connect": (request) =>
        connectProviders(request).pipe(Effect.provideContext(connectContext)),
      "browser.subscribe": ({ botId }) => browserTabs.subscribe(botId, device.id),
      // The secrets' requests carry or answer values: none is logged, and none has a receipt.
      "secrets.status": () => secrets.status,
      "secrets.list": () => secrets.list,
      "secrets.reveal": ({ id, field }) => secrets.reveal({ id, field, deviceId: device.id }),
      "secrets.add": (input) => secretAsks.add(input),
      "secrets.addFromAsk": (input) => secretAsks.addFromAsk(input),
      "secrets.update": (input) => secrets.update(input),
      "secrets.delete": ({ id }) => secrets.remove(id),
      "secrets.setAccess": ({ id, access }) => secrets.setAccess(id, access),
      "secrets.totpPreview": ({ id }) => secrets.totpPreview(id),
      // A connector's add and update carry its secrets, redacted: none is logged, and neither has a receipt.
      "connectors.subscribe": () => connectors.subscribe,
      // Each change is recorded as the operator's (decision 0049).
      "connector.add": (input) => connectors.add({ ...input, by: operator }),
      "connector.update": (input) => connectors.update({ ...input, by: operator }),
      "connector.remove": (input) => connectors.remove(input),
      "connector.setBots": (input) => connectors.setBots({ ...input, by: operator }),
      "connector.prompts": ({ botId }) => connectors.menuPrompts(botId),
      "connector.renderPrompt": (input) => connectors.renderPrompt(input),
      "connectorApp.open": ({ viewId }) => connectorApps.open(viewId),
      "connectorApp.callTool": (input) => connectorApps.callTool(input),
      "connectorApp.readResource": (input) => connectorApps.readResource(input),
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
      // A change is recorded as the operator's (decision 0049).
      "skills.subscribe": () => skills.subscribe,
      "skill.read": ({ scope, name }) => skills.read(scope, name),
      "skill.save": (input) => skills.save({ ...input, by: operator }),
      "skill.install": (input) =>
        skills.install({ ...input, by: operator }).pipe(
          Effect.catchTags({
            NotASkill: () => Effect.fail(new Invalid({ reason: "skill-repository" })),
            SkillFetchFailed: () => Effect.fail(new Conflict({ reason: "skill-fetch" })),
          }),
        ),
      "skill.remove": (input) => skills.remove(input),
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
