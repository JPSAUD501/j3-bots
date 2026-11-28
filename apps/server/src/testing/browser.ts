// SPDX-License-Identifier: AGPL-3.0-or-later
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import type { BotId, BrowserTabRef, DeviceId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Browser } from "../browser/Browser.ts";
import { ServerBrowser, ServerBrowserUnavailable } from "../browser/server/ServerBrowser.ts";
import { Devices } from "../devices/Devices.ts";

/** The server's browser in tests: a fake page host, started like the real one. */
export class TestServerBrowser extends Context.Service<
  TestServerBrowser,
  {
    /** The browser running now, if one is. */
    readonly current: Effect.Effect<Option.Option<FakePageHost>>;
    /** The browser running now: a test that needs one fails without it. */
    readonly running: Effect.Effect<FakePageHost>;
    /** From now on the browser does not start, as `reason` says; null starts it again. */
    readonly refuse: (reason: ServerBrowserUnavailable["reason"] | null) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/browser/TestServerBrowser") {}

/** `ServerBrowser` as a fake page host, with `TestServerBrowser` to reach it. */
export const testServerBrowserLayer = Layer.effectContext(
  Effect.gen(function* () {
    const current = yield* Ref.make(Option.none<FakePageHost>());
    const refused = yield* Ref.make<ServerBrowserUnavailable["reason"] | null>(null);
    const control = TestServerBrowser.of({
      current: Ref.get(current),
      running: Ref.get(current).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("The server's browser is not running"),
            onSome: Effect.succeed,
          }),
        ),
      ),
      refuse: (reason) => Ref.set(refused, reason),
    });
    const server = ServerBrowser.of({
      hostStatus: Stream.make(Option.some({ _tag: "ready" as const })),
      launch: Effect.gen(function* () {
        const reason = yield* Ref.get(refused);
        if (reason !== null) return yield* new ServerBrowserUnavailable({ reason });
        const host = yield* makeFakePageHost({ host: { kind: "server" } });
        yield* Ref.set(current, Option.some(host));
        yield* Effect.addFinalizer(() => Ref.set(current, Option.none()));
        return { ...host, tabCount: Effect.map(host.tabs, (tabs) => tabs.length) };
      }),
    });
    return Context.make(TestServerBrowser, control).pipe(Context.add(ServerBrowser, server));
  }),
);

/** `botId` opens `url` in a new tab, as its `browser_open` would: the tab is its current one. */
export const botOpens = (botId: BotId, url: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const opened = yield* browser.tools.open(botId, { url }).pipe(Effect.orDie);
    return opened.tab satisfies BrowserTabRef;
  });

/** The devices each test's server paired through `operatorDevice`, by name. */
const pairedByServer = new WeakMap<Devices["Service"], Map<string, DeviceId>>();

/**
 * The operator's device called `name`, paired the first time a test's server
 * is asked for it. A person holds a tab from a paired device: a hold from a
 * device the server does not know ends at once, as a revoked one's does.
 */
export const operatorDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const paired = pairedByServer.get(devices) ?? new Map<string, DeviceId>();
    pairedByServer.set(devices, paired);
    const known = paired.get(name);
    if (known !== undefined) return known;
    const { code } = yield* devices.startPairing;
    const { deviceId } = yield* devices.pair({ code, name }).pipe(Effect.orDie);
    paired.set(name, deviceId);
    return deviceId;
  });
