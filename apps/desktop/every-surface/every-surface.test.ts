// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type ApprovalEntry,
  type Bot,
  type BotId,
  CommandId,
  type EntryId,
  type EntryTarget,
  HTTP_PATHS,
  J3Rpcs,
  type MessageEntry,
  normalizePairingCode,
  PairingCode,
  PairRequest,
  PairResult,
  type QuestionEntry,
  type ReceivedEntry,
} from "@j3-bots/contracts";
import { DEFAULT_SHORTCUT } from "@j3-bots/desktop-bridge";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import {
  environment,
  launch,
  linkTo,
  openToken,
  SealedRecord,
  STEP,
  storedCredential,
} from "../test/electron.ts";
import { labelled, makePhone, type Phone, type Shown } from "./phone.ts";
import { type Relay, relayTo } from "./relay.ts";

// The every-surface check (docs/operations/every-surface-check.md): the
// promises J3 Bots makes across devices, kept end to end on the desktop app
// and the Android app against one server.
//
// The server is a development server with the scripted agent
// (`apps/server/every-surface/host.ts`). This side pairs a client of its own
// to set the scene and read what the server holds, launches the desktop app
// (the development build, driven with Playwright) and drives the Android app
// (the development build on an emulator, driven with agent-device), each
// paired as its own device. Every step passes on assertions.
//
// Needs a display (`xvfb-run`), the web client and the desktop app built, and
// the settings below. Runs by hand: no CI job has a display and an emulator.

/** How long a resolution made on one device may take to show on another: the subscription's latency. */
const LIVE = 5_000;
/** How long the server may take to show what a client sent. */
const ARRIVES = 60_000;
/** The development build, with Chromium kept off the system's keyring. */
const DESKTOP_ARGS = ["--password-store=basic"];

const Settings = Config.all({
  /** The server as this machine reaches it. */
  server: Config.String("J3_EVERY_SURFACE_SERVER"),
  /** A pairing code for this side's own client, from the server side's output. */
  code: Config.Redacted("J3_EVERY_SURFACE_CODE"),
  /** The server as the phone reaches it; the emulator's alias for its host's loopback by default. */
  phoneServer: Config.option(Config.String("J3_EVERY_SURFACE_PHONE_SERVER")),
  /** What runs one shell line where adb and agent-device reach the emulator. */
  phoneShell: Config.String("J3_EVERY_SURFACE_PHONE_SHELL").pipe(Config.withDefault("sh -c")),
  /** Metro, as the phone reaches it through `adb reverse`. */
  metro: Config.String("J3_EVERY_SURFACE_METRO").pipe(Config.withDefault("http://127.0.0.1:8081")),
  /** Where the captures go. */
  captures: Config.option(Config.String("J3_EVERY_SURFACE_CAPTURES")),
});

const connect = (server: URL, token: string) =>
  Effect.gen(function* () {
    const socket = new URL(HTTP_PATHS.rpc, server);
    socket.protocol = server.protocol === "https:" ? "wss:" : "ws:";
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          NodeSocket.layerWebSocket(socket.href, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));
  });
type Client = Effect.Success<ReturnType<typeof connect>>;

/** Every entry of `target` the first page holds. */
const entriesOf = (client: Client, target: EntryTarget) =>
  client["entries.subscribe"]({ target, after: null }).pipe(
    Stream.runHead,
    Effect.map((frame) =>
      Option.isSome(frame) && frame.value._tag === "snapshot" ? frame.value.entries : [],
    ),
  );

/** Marks everything in `target` read, as reading it on a device does. */
const markAllRead = (client: Client, target: EntryTarget) =>
  entriesOf(client, target).pipe(
    Effect.flatMap((entries) => {
      const last = entries.reduce<ReceivedEntry | undefined>(
        (latest, entry) => (latest === undefined || entry.order > latest.order ? entry : latest),
        undefined,
      );
      return last === undefined
        ? Effect.void
        : client["entries.markRead"]({ target, through: last.order });
    }),
  );

/** The first entry of `target` that `matches`, as soon as there is one. */
const awaitEntry = <A extends ReceivedEntry>(
  client: Client,
  target: EntryTarget,
  matches: (entry: ReceivedEntry) => entry is A,
  what: string,
) =>
  client["entries.subscribe"]({ target, after: null }).pipe(
    Stream.flatMap((frame) =>
      Stream.fromIterable(frame._tag === "snapshot" ? frame.entries : frame.upsert),
    ),
    Stream.filter(matches),
    Stream.runHead,
    Effect.flatMap((found) => Effect.fromOption(found)),
    Effect.timeoutOrElse({
      duration: ARRIVES,
      orElse: () => Effect.die(`The server never showed ${what}.`),
    }),
  );

const operatorSaid =
  (text: string) =>
  (entry: ReceivedEntry): entry is MessageEntry =>
    entry._tag === "message" &&
    entry.author._tag === "operator" &&
    entry.text === text &&
    entry.delivery._tag === "delivered";

const botSaid =
  (text: string) =>
  (entry: ReceivedEntry): entry is MessageEntry =>
    entry._tag === "message" && entry.author._tag === "bot" && entry.text === text;

const pendingQuestion = (entry: ReceivedEntry): entry is QuestionEntry =>
  entry._tag === "question" && entry.status._tag === "pending";

const pendingApproval = (entry: ReceivedEntry): entry is ApprovalEntry =>
  entry._tag === "approval" && entry.status._tag === "pending";

/** Once the bot has been idle for three seconds running: no turn left to steer into. */
const quiet = (client: Client, botId: BotId) =>
  client["roster.subscribe"]().pipe(
    Stream.flatMap((frame) =>
      Stream.fromIterable(frame._tag === "snapshot" ? frame.items : frame.upsert),
    ),
    Stream.filter((item) => item._tag === "bot" && item.bot.id === botId),
    Stream.map((item) => (item._tag === "bot" ? item.bot.state : { _tag: "idle" as const })),
    Stream.debounce("3 seconds"),
    Stream.filter((state) => state._tag === "idle"),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: ARRIVES,
      orElse: () => Effect.die("The bot never went quiet."),
    }),
  );

/** How many entries of `target` are the operator's `text`: each message must arrive once. */
const countOnServer = (client: Client, target: EntryTarget, text: string) =>
  entriesOf(client, target).pipe(
    Effect.map(
      (entries) =>
        entries.filter(
          (entry) =>
            entry._tag === "message" && entry.author._tag === "operator" && entry.text === text,
        ).length,
    ),
  );

/** The order of `texts` among the server's entries of `target`, each by its first message. */
const orderOnServer = (client: Client, target: EntryTarget, texts: ReadonlyArray<string>) =>
  entriesOf(client, target).pipe(
    Effect.map((entries) =>
      texts
        .map((text) => ({
          text,
          at: entries.findIndex((entry) => entry._tag === "message" && entry.text === text),
        }))
        .sort((a, b) => a.at - b.at)
        .map(({ text }) => text),
    ),
  );

/** Asserts each of `shown` appears exactly once, and in the order `expected` gives. */
const assertOnceInOrder = (
  where: string,
  shown: ReadonlyArray<Shown>,
  expected: ReadonlyArray<string>,
) => {
  for (const { text, at } of shown) {
    assert.lengthOf(at, 1, `${where} shows "${text}" ${at.length} times`);
  }
  const order = [...shown].sort((a, b) => (a.at[0] ?? 0) - (b.at[0] ?? 0)).map(({ text }) => text);
  assert.deepStrictEqual(order, [...expected], `${where} shows them out of order`);
};

/** Each of `texts` as the desktop's timeline shows it: elements whose whole text it is, top to bottom. */
const shownOnDesktop = (page: Page, texts: ReadonlyArray<string>) =>
  Effect.promise(() =>
    Promise.all(
      texts.map(async (text): Promise<Shown> => {
        const boxes = await Promise.all(
          (await page.locator("[data-seen-id]").getByText(text, { exact: true }).all()).map(
            (element) => element.boundingBox(),
          ),
        );
        return {
          text,
          at: boxes.flatMap((box) => (box === null ? [] : [box.y])).sort((a, b) => a - b),
        };
      }),
    ),
  );

/** Writes `text` in the desktop's composer for `name` and sends it. */
/** The buttons in `scope` that still take a press. */
const enabledButtons = (scope: Locator) =>
  scope.locator(
    'button:not([disabled]):not([aria-disabled="true"]), [role="button"]:not([aria-disabled="true"])',
  );

const sendOnDesktop = async (page: Page, name: string, text: string) => {
  await page.getByRole("combobox", { name: `Message ${name}` }).fill(text, { timeout: STEP });
  await page.getByRole("button", { name: "Send message" }).click({ timeout: STEP });
};

/**
 * Records, in the main process, what the app hands the system: each
 * notification it shows, and each menu its tray is given. Playwright reaches
 * neither through the system, so the check reads them where the app makes them.
 */
const watchMainProcess = (app: ElectronApplication) =>
  Effect.promise(() =>
    app.evaluate(({ Notification, Tray }) => {
      const shown: Array<InstanceType<typeof Notification>> = [];
      const menus: Array<ReadonlyArray<string>> = [];
      const show = Notification.prototype.show;
      Notification.prototype.show = function (this: InstanceType<typeof Notification>) {
        shown.push(this);
        show.call(this);
      };
      const setContextMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (
        this: InstanceType<typeof Tray>,
        menu: Parameters<InstanceType<typeof Tray>["setContextMenu"]>[0],
      ) {
        if (menu !== null) menus.push(menu.items.map((item) => item.label));
        setContextMenu.call(this, menu);
      };
      Reflect.set(globalThis, "j3EverySurfaceNotifications", shown);
      Reflect.set(globalThis, "j3EverySurfaceTrayMenus", menus);
    }),
  );

const Notifications = Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }));
const TrayMenus = Schema.Array(Schema.Array(Schema.String));

/** Each notification the app showed since it launched: its title and body. */
const notificationsShown = (app: ElectronApplication) =>
  Effect.promise(() =>
    app.evaluate(({ Notification }) => {
      const shown: unknown = Reflect.get(globalThis, "j3EverySurfaceNotifications");
      return Array.isArray(shown)
        ? shown.flatMap((notification: unknown) =>
            notification instanceof Notification
              ? [{ title: notification.title, body: notification.body }]
              : [],
          )
        : [];
    }),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Notifications)));

/** Clicks the `index`th notification shown, as the system reports a click to the app. */
const clickNotification = (app: ElectronApplication, index: number) =>
  Effect.promise(() =>
    app.evaluate(({ Notification }, index) => {
      const shown: unknown = Reflect.get(globalThis, "j3EverySurfaceNotifications");
      const notification: unknown = Array.isArray(shown) ? shown[index] : undefined;
      if (notification instanceof Notification) notification.emit("click");
    }, index),
  );

/** The labels of the menu the tray holds now. */
const trayMenu = (app: ElectronApplication) =>
  Effect.promise(() => app.evaluate(() => Reflect.get(globalThis, "j3EverySurfaceTrayMenus"))).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TrayMenus)),
    Effect.map((menus) => menus.at(-1) ?? []),
  );

/** The tray's labels once `holds` holds for them, within a step. */
const trayShows = (
  app: ElectronApplication,
  holds: (labels: ReadonlyArray<string>) => boolean,
  failure: string,
) =>
  trayMenu(app).pipe(
    Effect.repeat({ until: holds, schedule: Schedule.spaced("200 millis") }),
    Effect.timeoutOrElse({
      duration: STEP,
      orElse: () =>
        trayMenu(app).pipe(
          Effect.flatMap((labels) => Effect.die(`${failure}: ${labels.join(", ")}`)),
        ),
    }),
  );

interface Desktop {
  readonly app: ElectronApplication;
  readonly page: Page;
}

/** What every step shares: the server, its client, the bots, both devices. */
class Rig extends Context.Service<
  Rig,
  {
    readonly server: URL;
    readonly client: Client;
    readonly bot: Bot;
    readonly other: Bot;
    readonly relay: Relay;
    readonly phone: Phone;
    readonly profile: string;
    /** The desktop app as it runs now: the check kills it and launches it again. */
    readonly desktop: () => Desktop;
    readonly relaunchDesktop: Effect.Effect<Desktop>;
    /** Runs `steps` on the desktop's page. */
    readonly onDesktop: <A>(steps: (page: Page) => Promise<A>) => Effect.Effect<A>;
    /** Screenshots of both devices, as `<name>-desktop.png` and `<name>-phone.png`. */
    readonly capture: (name: string) => Effect.Effect<void>;
    /**
     * Stops both bots' turns. A turn left waiting on a card holds one of the
     * server's few turn slots, so a failed step stops them for the steps after
     * it and for the next run on the same server.
     */
    readonly stopTurns: Effect.Effect<void>;
  }
>()("@j3-bots/desktop/every-surface/every-surface.test/Rig") {}

const rig = Effect.gen(function* () {
  const settings = yield* Settings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const server = new URL(settings.server);
  // Names and command ids of this run, so a second run on one server takes none of the first's.
  const run = String((yield* Clock.currentTimeMillis) % 100_000);
  const commandId = (label: string) => CommandId.make(`every-surface-${run}-${label}`);

  // This side's own client: it sets the scene and reads what the server holds.
  const pair = (code: PairingCode, name: string) =>
    HttpClientRequest.post(new URL(HTTP_PATHS.pair, server).href).pipe(
      HttpClientRequest.schemaBodyJson(PairRequest)({ code, name }),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PairResult)),
    );
  const { token } = yield* pair(
    yield* Schema.decodeEffect(PairingCode)(normalizePairingCode(Redacted.value(settings.code))),
    "Every-surface check",
  );
  const client = yield* connect(server, token);
  const pairingCode = client["pairing.start"]().pipe(Effect.map(({ code }) => code));

  const bot = yield* client["bot.create"]({
    commandId: commandId("bot"),
    name: `Echo ${run}`,
    // Approvals reach the operator only in this mode.
    permissionMode: "supervised",
  });
  const other = yield* client["bot.create"]({
    commandId: commandId("other"),
    name: `Other ${run}`,
  });
  let stops = 0;
  const stopTurns = Effect.forEach(
    [bot.id, other.id],
    (botId) =>
      client["bot.stop"]({ commandId: commandId(`stop-${++stops}`), botId }).pipe(Effect.ignore),
    { discard: true },
  );
  yield* Effect.addFinalizer(() => stopTurns);
  // Each new bot opens its conversation with a turn of its own.
  yield* quiet(client, bot.id);
  yield* quiet(client, other.id);

  const captures = Option.getOrElse(settings.captures, () =>
    path.join(path.resolve(import.meta.dirname, ".."), "every-surface-captures"),
  );
  yield* fs.makeDirectory(captures, { recursive: true });
  const relay = yield* relayTo(server);
  const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-every-surface-desktop-" });

  const openDesktop = Effect.gen(function* () {
    const app = yield* launch(profile, DESKTOP_ARGS);
    const page = yield* Effect.promise(() => app.firstWindow({ timeout: STEP }));
    yield* watchMainProcess(app);
    return { app, page };
  });
  let desktop = yield* openDesktop;
  const scope = yield* Effect.scope;

  const shellWords = settings.phoneShell.split(/\s+/).filter((word) => word !== "");
  const [program, ...before] = shellWords;
  if (program === undefined) return yield* Effect.die("J3_EVERY_SURFACE_PHONE_SHELL is empty");
  const phone = makePhone([program, ...before], settings.metro);

  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >();
  const capture = (name: string) =>
    Effect.all(
      [
        Effect.promise(() =>
          desktop.page.screenshot({ path: path.join(captures, `${name}-desktop.png`) }),
        ),
        phone.screenshot(path.join(captures, `${name}-phone.png`)),
      ],
      { concurrency: 2 },
    ).pipe(Effect.asVoid, Effect.orDie, Effect.provide(services));

  // The desktop pairs, through the relay.
  yield* Effect.promise(async () => {
    const { page } = desktop;
    await page.getByLabel("Server address").fill(relay.host, { timeout: STEP });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Pairing code").waitFor({ timeout: STEP });
  });
  const desktopCode = yield* pairingCode;
  yield* Effect.promise(async () => {
    const { page } = desktop;
    await page.getByLabel("Pairing code").fill(desktopCode, { timeout: STEP });
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByText(bot.profile.name).first().waitFor({ timeout: STEP });
  });

  // The phone pairs, as new.
  const phoneServer = Option.getOrElse(
    settings.phoneServer,
    () => `${server.protocol}//10.0.2.2:${server.port}`,
  );
  yield* phone.openFresh;
  yield* phone.fill(labelled("Server address", "text-field"), phoneServer);
  yield* phone.fill(labelled("Pairing code", "text-field"), yield* pairingCode);
  yield* phone.press(labelled("Pair", "button"));
  yield* phone.waitText(bot.profile.name, STEP);

  return Rig.of({
    server,
    client,
    bot,
    other,
    relay,
    phone,
    profile,
    desktop: () => desktop,
    relaunchDesktop: openDesktop.pipe(
      Effect.tap((next) =>
        Effect.sync(() => {
          desktop = next;
        }),
      ),
      Scope.provide(scope),
    ),
    onDesktop: (steps) =>
      Effect.promise(() => steps(desktop.page)).pipe(
        Effect.onError(() => capture("failure").pipe(Effect.ignore)),
      ),
    capture,
    stopTurns,
  });
});

/** A step that, when it fails, leaves no turn of the check's bots running. */
const step = <A, E, R>(steps: Effect.Effect<A, E, R>) =>
  steps.pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        const { stopTurns } = yield* Rig;
        yield* stopTurns;
      }),
    ),
  );

it.layer(
  Layer.effect(Rig, rig).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
  { timeout: "10 minutes", excludeTestServices: true },
)("every surface", (it) => {
  it.effect(
    "continuity: what one device writes, the other shows, once and in order, offline and killed too",
    () =>
      step(
        Effect.gen(function* () {
          const { client, bot, phone, relay, desktop, relaunchDesktop, onDesktop, capture } =
            yield* Rig;
          const target = { _tag: "conversation", botId: bot.id } as const;
          const name = bot.profile.name;
          const composer = `Message ${name}`;
          const first = "Desktop, first";
          const reply = "Hello-from-the-bot";
          const second = `Desktop, second [[script:speak text=${reply}]]`;

          // Two messages from the desktop; the second asks the bot for a reply.
          yield* onDesktop(async (page) => {
            await page.getByText(name).first().click({ timeout: STEP });
            await sendOnDesktop(page, name, first);
          });
          yield* awaitEntry(client, target, operatorSaid(first), "the desktop's first message");
          yield* quiet(client, bot.id);
          yield* onDesktop((page) => sendOnDesktop(page, name, second));
          yield* awaitEntry(client, target, botSaid(reply), "the bot's reply");
          yield* quiet(client, bot.id);

          // The phone shows both, in order, and the reply.
          yield* phone.press(`text=${JSON.stringify(name)}`);
          yield* phone.waitText(reply, STEP);
          assertOnceInOrder("The phone", yield* phone.shown([first, second, reply]), [
            first,
            second,
            reply,
          ]);
          yield* capture("1-continuity");

          // Offline, the phone keeps two messages; the desktop writes meanwhile.
          const phoneFirst = "Phone, first while offline";
          const phoneSecond = "Phone, second while offline";
          const meanwhile = "Desktop, meanwhile";
          // The conversation shows no connection line: the server's count says nothing went.
          yield* Effect.gen(function* () {
            yield* phone.airplane(true);
            yield* phone.send(composer, phoneFirst);
            yield* phone.send(composer, phoneSecond);
            yield* phone.waitText(phoneSecond, STEP);
            yield* onDesktop((page) => sendOnDesktop(page, name, meanwhile));
            yield* awaitEntry(client, target, operatorSaid(meanwhile), "the desktop's message");
            assert.strictEqual(yield* countOnServer(client, target, phoneFirst), 0);
            assert.strictEqual(yield* countOnServer(client, target, phoneSecond), 0);
            yield* capture("1-phone-offline");
          }).pipe(Effect.ensuring(phone.airplane(false).pipe(Effect.ignore)));

          // Back online: each message once, and both devices in the server's order.
          yield* awaitEntry(
            client,
            target,
            operatorSaid(phoneSecond),
            "the phone's second message",
          );
          yield* quiet(client, bot.id);
          const written = [meanwhile, phoneFirst, phoneSecond];
          const order = yield* orderOnServer(client, target, written);
          // The phone's two arrive in the order written, after the desktop's, sent while it was away.
          assert.deepStrictEqual(order, written);
          for (const text of written) {
            assert.strictEqual(
              yield* countOnServer(client, target, text),
              1,
              `"${text}" arrived twice`,
            );
          }
          yield* onDesktop((page) =>
            page
              .locator("[data-seen-id]")
              .getByText(phoneSecond, { exact: true })
              .waitFor({ timeout: STEP }),
          );
          assertOnceInOrder("The desktop", yield* shownOnDesktop(desktop().page, written), order);
          assertOnceInOrder("The phone", yield* phone.shown(written), order);
          yield* capture("1-phone-back");

          // Killed with a draft and an unsent message, the desktop keeps both and sends the message once.
          const unsent = "Desktop, unsent when killed";
          const draft = "Desktop, a draft when killed";
          // Cut off, the message cannot go; the bubble shows it waiting, with no entry of the server's yet.
          yield* Effect.gen(function* () {
            yield* relay.cut;
            yield* onDesktop(async (page) => {
              await page
                .getByText(/^(Reconnecting…|Connection to J3 Bots lost\.|Can’t reach J3 Bots\.)$/)
                .first()
                .waitFor({ timeout: STEP });
              await sendOnDesktop(page, name, unsent);
              // The bubble's own delivery line: its root is the message's focus target.
              await page
                .locator('[tabindex="-1"]', { has: page.getByText(unsent, { exact: true }) })
                .last()
                .getByRole("status")
                .getByText("Sending…", { exact: true })
                .waitFor({ timeout: STEP });
              await page.getByRole("combobox", { name: composer }).fill(draft);
              await page.getByText("Not saved yet").waitFor({ state: "hidden", timeout: STEP });
            });
            yield* capture("1-desktop-before-kill");
            yield* Effect.sync(() => desktop().app.process().kill("SIGKILL"));
            assert.strictEqual(yield* countOnServer(client, target, unsent), 0);
          }).pipe(Effect.ensuring(relay.restore));
          yield* relaunchDesktop;
          yield* onDesktop(async (page) => {
            await page.getByText(name).first().click({ timeout: STEP });
            const field = page.getByRole("combobox", { name: composer });
            await field.waitFor({ timeout: STEP });
            assert.strictEqual(await field.inputValue(), draft, "the draft was lost");
          });
          yield* awaitEntry(client, target, operatorSaid(unsent), "the unsent message");
          yield* quiet(client, bot.id);
          assert.strictEqual(yield* countOnServer(client, target, unsent), 1);
          yield* onDesktop((page) =>
            page
              .locator("[data-seen-id]")
              .getByText(unsent, { exact: true })
              .waitFor({ timeout: STEP }),
          );
          assertOnceInOrder("The desktop", yield* shownOnDesktop(desktop().page, [unsent]), [
            unsent,
          ]);
          yield* capture("1-desktop-sent");
        }),
      ),
    10 * 60_000,
  );

  it.effect(
    "cross-device resolution: a card answered on the phone shows resolved on the desktop, and stays answered",
    () =>
      step(
        Effect.gen(function* () {
          const { server, client, bot, phone, desktop, onDesktop, capture } = yield* Rig;
          const target = { _tag: "conversation", botId: bot.id } as const;
          const card = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`);
          // The desktop's own credential, to answer again as the desktop.
          const record = yield* Schema.decodeUnknownEffect(SealedRecord)(
            yield* Effect.promise(() => storedCredential(desktop().page)),
          );
          const desktopToken = yield* openToken(desktop().page, record.sealed).pipe(
            Effect.flatMap((opened) => Effect.fromOption(opened)),
            Effect.orDie,
          );
          const asDesktop = yield* connect(server, desktopToken);
          let answers = 0;
          const answerAgain = (
            entryId: EntryId,
            answer: Parameters<Client["card.answer"]>[0]["answer"],
          ) =>
            asDesktop["card.answer"]({
              commandId: CommandId.make(`every-surface-again-${entryId}-${++answers}`),
              entryId,
              answer,
            }).pipe(Effect.flip);

          // A question: the phone answers, the desktop's card shows it without a reload.
          yield* client["message.send"]({
            commandId: CommandId.make(`every-surface-question-${bot.id}`),
            target,
            text: "[[script:question]]",
            attachments: [],
          });
          const asked = yield* awaitEntry(client, target, pendingQuestion, "the question");
          const [question] = asked.questions;
          const red = question.options.find((option) => option.label === "Red");
          if (red === undefined) return yield* Effect.die("The question offers no Red");
          yield* onDesktop((page) => card(page, asked.id).waitFor({ timeout: STEP }));
          // A single choice answers on a tap. The scripted agent's option repeats its label as its
          // description, which the card leaves out.
          yield* phone.waitText("Needs your answer", STEP);
          yield* phone.press(labelled("Red", "button"));
          yield* onDesktop(async (page) => {
            await card(page, asked.id)
              .getByText("Answered", { exact: true })
              .waitFor({ timeout: LIVE });
            assert.strictEqual(
              await enabledButtons(card(page, asked.id)).count(),
              0,
              "the desktop still offers to answer",
            );
          });
          yield* capture("2-question");
          const refused = yield* answerAgain(asked.id, {
            _tag: "question",
            answers: { [question.id]: { optionIds: [red.id], text: null } },
          });
          assert.strictEqual(refused._tag, "Conflict");
          if (refused._tag === "Conflict") assert.strictEqual(refused.reason, "card-closed");
          yield* quiet(client, bot.id);

          // An approval: the same.
          yield* client["message.send"]({
            commandId: CommandId.make(`every-surface-approval-${bot.id}`),
            target,
            text: "[[script:approval]]",
            attachments: [],
          });
          const approval = yield* awaitEntry(client, target, pendingApproval, "the approval");
          yield* onDesktop((page) => card(page, approval.id).waitFor({ timeout: STEP }));
          yield* phone.waitText("Allow once", STEP);
          yield* phone.press(labelled("Allow once", "button"));
          yield* onDesktop(async (page) => {
            await card(page, approval.id)
              .getByText("Allowed once", { exact: true })
              .waitFor({ timeout: LIVE });
            assert.strictEqual(
              await enabledButtons(card(page, approval.id)).count(),
              0,
              "the desktop still offers to decide",
            );
          });
          yield* capture("2-approval");
          const again = yield* answerAgain(approval.id, {
            _tag: "approval",
            decision: "allow-once",
          });
          assert.strictEqual(again._tag, "Conflict");
          if (again._tag === "Conflict") assert.strictEqual(again.reason, "card-closed");
          yield* quiet(client, bot.id);
        }),
      ),
    5 * 60_000,
  );

  it.effect(
    "surfaces: a notification's click opens its conversation",
    () =>
      step(
        Effect.gen(function* () {
          const { client, bot, other, phone, desktop, onDesktop, capture } = yield* Rig;
          const target = { _tag: "conversation", botId: bot.id } as const;
          // The server notifies about what no connected device has in view: the phone leaves it.
          yield* phone.press(labelled("Back to bots", "button"));
          const said = "Hello-while-you-were-away";
          const before = (yield* notificationsShown(desktop().app)).length;
          // With another conversation open, the bot's message is out of view: the app notifies.
          yield* onDesktop((page) =>
            page.getByText(other.profile.name).first().click({ timeout: STEP }),
          );
          yield* client["message.send"]({
            commandId: CommandId.make(`every-surface-notify-${bot.id}`),
            target,
            text: `[[script:speak text=${said}]]`,
            attachments: [],
          });
          yield* awaitEntry(client, target, botSaid(said), "the bot's message");
          const shown = yield* notificationsShown(desktop().app).pipe(
            Effect.map((all) =>
              all
                .slice(before)
                // Previews are off on a new server: the body names the kind, not the text.
                .findIndex((n) => n.body === "Sent you a message"),
            ),
            Effect.repeat({
              until: (index) => index >= 0,
              schedule: Schedule.spaced("200 millis"),
            }),
            Effect.timeoutOrElse({
              duration: STEP,
              orElse: () => Effect.die("No notification showed"),
            }),
          );
          yield* clickNotification(desktop().app, before + shown);
          yield* onDesktop(async (page) => {
            await page.waitForURL(`j3bots-dev://app/bots/${bot.id}`, { timeout: STEP });
            await page
              .getByRole("combobox", { name: `Message ${bot.profile.name}` })
              .waitFor({ timeout: STEP });
          });
          yield* capture("3-notification");
          yield* quiet(client, bot.id);
        }),
      ),
    2 * 60_000,
  );

  it.effect(
    "surfaces: the tray lists the bot that waits",
    () =>
      step(
        Effect.gen(function* () {
          const { client, bot, desktop, capture } = yield* Rig;
          const target = { _tag: "conversation", botId: bot.id } as const;
          // Read, with nothing waiting, the bot is not in the tray.
          yield* markAllRead(client, target);
          yield* trayShows(
            desktop().app,
            (labels) => !labels.includes(bot.profile.name),
            "The tray lists the bot before it waits",
          );
          yield* client["message.send"]({
            commandId: CommandId.make(`every-surface-tray-${bot.id}`),
            target,
            text: "[[script:question]]",
            attachments: [],
          });
          const asked = yield* awaitEntry(client, target, pendingQuestion, "the question");
          const [question] = asked.questions;
          const red = question.options.find((option) => option.label === "Red");
          if (red === undefined) return yield* Effect.die("The question offers no Red");
          // Read through the question, so only the wait keeps the bot in the tray.
          yield* markAllRead(client, target);
          const menu = yield* trayShows(
            desktop().app,
            (labels) => labels.includes(bot.profile.name),
            "The tray never listed the waiting bot",
          );
          // How many wait depends on what earlier runs against the same server left.
          assert.isTrue(
            menu.some((label) => /^\d+ needs? you$/.test(label)),
            `the tray says nothing waits: ${menu.join(", ")}`,
          );
          yield* capture("3-tray");
          yield* client["card.answer"]({
            commandId: CommandId.make(`every-surface-tray-answer-${bot.id}`),
            entryId: asked.id,
            answer: {
              _tag: "question",
              answers: { [question.id]: { optionIds: [red.id], text: null } },
            },
          });
          yield* quiet(client, bot.id);
          // Answered and read, it leaves the tray.
          yield* markAllRead(client, target);
          yield* trayShows(
            desktop().app,
            (labels) => !labels.includes(bot.profile.name),
            "The tray still lists the bot once its question is answered",
          );
        }),
      ),
    2 * 60_000,
  );

  it.effect("surfaces: the global shortcut is the system's", () =>
    step(
      Effect.gen(function* () {
        const { desktop } = yield* Rig;
        // Pressing it needs an input tool the display may not have; the
        // desktop smoke runs the Show it triggers, composer focus included.
        const registered = yield* Effect.promise(() =>
          desktop().app.evaluate(
            ({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator),
            DEFAULT_SHORTCUT,
          ),
        );
        assert.isTrue(registered, "the default shortcut is not registered with the system");
      }),
    ),
  );

  it.effect(
    "surfaces: xdg-open with a link to a bot opens it",
    () =>
      step(
        Effect.gen(function* () {
          const { other, profile, onDesktop, capture } = yield* Rig;
          const link = linkTo({ _tag: "open", target: { _tag: "conversation", botId: other.id } });
          const opened = yield* (yield* ChildProcessSpawner.ChildProcessSpawner)
            .spawn(
              ChildProcess.make("xdg-open", [link], {
                env: environment(profile),
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            )
            .pipe(
              Effect.flatMap((handle) => handle.exitCode),
              Effect.scoped,
            );
          assert.strictEqual(Number(opened), 0);
          yield* onDesktop(async (page) => {
            await page.waitForURL(`j3bots-dev://app/bots/${other.id}`, { timeout: STEP });
            await page
              .getByRole("combobox", { name: `Message ${other.profile.name}` })
              .waitFor({ timeout: STEP });
          });
          yield* capture("3-link");
        }),
      ),
    2 * 60_000,
  );
});
