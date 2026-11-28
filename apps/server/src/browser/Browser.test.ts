// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import { type BotId, BrowserTabRef, DeviceId, type SharedBrowserTab } from "@j3-bots/contracts";
import { BROWSER_NOTES } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { operatorDevice, TestServerBrowser } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot } from "../testing/turns.ts";
import { Browser, DESKTOP_GRACE, SERVER_TAB_CAP } from "./Browser.ts";
import { BOT_LEASE } from "./TabControl.ts";

const laptop = DeviceId.make("device-laptop");

/** The tabs as the person sees them, once the list has caught up with `until`. */
const tabsWhen = (until: (tabs: ReadonlyArray<SharedBrowserTab>) => boolean) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const found = yield* browser.all.pipe(
      Stream.map(({ tabs }) => tabs),
      Stream.filter(until),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

/** A desktop app's browser for `device`, attached until the returned scope closes. */
const desktop = (device: DeviceId) =>
  Effect.gen(function* () {
    const host = yield* makeFakePageHost({ host: { kind: "desktop", device } });
    const attached = yield* attach(host);
    // The server hears the host's events from here on.
    while (!(yield* host.calls).some((call) => call.call === "host.events")) {
      yield* Effect.yieldNow;
    }
    return { host, attached };
  });

const attach = (host: FakePageHost) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* (yield* Browser).attachHost(host).pipe(Scope.provide(scope), Effect.orDie);
    return scope;
  });

const open = (botId: BotId, url: string) =>
  Effect.gen(function* () {
    const opened = yield* (yield* Browser).tools.open(botId, { url }).pipe(Effect.orDie);
    return opened.tab;
  });

it.effect(
  "opens a bot's tab in the app the person used, parks it once the app has been gone a while, and opens it again on the server when the bot uses it",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const server = yield* TestServerBrowser;
      const bot = yield* createBot("Ana");
      const { host, attached } = yield* desktop(laptop);
      const ref = yield* open(bot.id, "https://news.example.test/");
      assert.deepStrictEqual(
        (yield* host.tabs).map((tab) => tab.tab),
        [ref],
      );
      assert.isTrue(Option.isNone(yield* server.current));

      yield* Scope.close(attached, Exit.void);
      yield* TestClock.adjust(DESKTOP_GRACE);
      yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref && tab.where.kind === "parked"));

      const read = yield* browser.tools.snapshot(bot.id, { tab: ref }).pipe(Effect.orDie);
      assert.strictEqual(read.url, "https://news.example.test/");
      assert.strictEqual(read.notice, BROWSER_NOTES.reopened);
      const running = yield* server.running;
      assert.deepStrictEqual(
        (yield* running.tabs).map((tab) => tab.tab),
        [ref],
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a desktop's tabs where they ran when it comes back within the grace", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const { host, attached } = yield* desktop(laptop);
    const ref = yield* open(bot.id, "https://news.example.test/");
    yield* Scope.close(attached, Exit.void);
    yield* attach(host);
    yield* TestClock.adjust(DESKTOP_GRACE);
    const tabs = yield* tabsWhen((all) => all.some((tab) => tab.ref === ref));
    assert.deepStrictEqual(
      tabs.map((tab) => tab.where),
      [{ kind: "desktop", device: laptop }],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "shows the person's private tabs to them only, through a reconnect, and forgets one once it closes",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const bot = yield* createBot("Ana");
      const { host, attached } = yield* desktop(laptop);
      const ref = BrowserTabRef.make("tab-private");
      const page = yield* host.open({ tab: ref, private: true, background: false });
      yield* host.emit({ type: "tab.opened", page, opener: null, private: true });
      const all = yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref));
      assert.isTrue(all.find((tab) => tab.ref === ref)?.private);
      assert.deepStrictEqual(yield* browser.tools.tabs(bot.id), []);
      const refused = yield* browser.tools.snapshot(bot.id, { tab: ref }).pipe(Effect.flip);
      assert.strictEqual(refused.text, BROWSER_NOTES.noTab(ref));

      // A reconnect keeps it: the host lists its private tabs apart.
      yield* Scope.close(attached, Exit.void);
      yield* attach(host);
      yield* TestClock.adjust(DESKTOP_GRACE);
      const again = yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref));
      assert.isTrue(again.find((tab) => tab.ref === ref)?.private);

      yield* host.emit({ type: "tab.closed", tab: ref, crashed: false });
      yield* tabsWhen((tabs) => !tabs.some((tab) => tab.ref === ref));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "refuses a bot's action while the person uses the tab, and lets it read the page meanwhile",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const bot = yield* createBot("Ana");
      const ref = yield* open(bot.id, "https://shop.example.test/");
      const phone = yield* operatorDevice("Phone");
      assert.isTrue(yield* browser.personUsed(ref, phone));
      const refused = yield* browser.tools
        .act(bot.id, ref, { action: "press", key: "Enter" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.text, BROWSER_NOTES.personHolds);
      const read = yield* browser.tools.snapshot(bot.id, { tab: ref }).pipe(Effect.orDie);
      assert.strictEqual(read.url, "https://shop.example.test/");
      // Another device's input is not the holder's.
      assert.isFalse(yield* browser.personUsed(ref, yield* operatorDevice("Laptop")));
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps the server's browser to its cap by parking the tab used least recently", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const refs: Array<BrowserTabRef> = [];
    for (let n = 0; n <= SERVER_TAB_CAP; n++) {
      refs.push(yield* open(bot.id, `https://page${n}.example.test/`));
      // The bot's lease on the tab it opened lapses: it is idle.
      yield* TestClock.adjust(BOT_LEASE);
    }
    const running = yield* (yield* TestServerBrowser).running;
    assert.strictEqual((yield* running.tabs).length, SERVER_TAB_CAP);
    const tabs = yield* tabsWhen((all) => all.length === refs.length);
    assert.strictEqual(tabs.find((tab) => tab.ref === refs[0])?.where.kind, "parked");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("tells a bot that no browser can run its tab when the server's cannot start", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const bot = yield* createBot("Ana");
    yield* (yield* TestServerBrowser).refuse("sandbox");
    const refused = yield* browser.tools
      .open(bot.id, { url: "https://news.example.test/" })
      .pipe(Effect.flip);
    assert.strictEqual(refused.text, BROWSER_NOTES.unavailable("sandbox"));
    assert.deepStrictEqual(
      yield* browser.serverProblem.pipe(Stream.runHead, Effect.map(Option.flatten)),
      Option.some("sandbox"),
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("ends a person's wait for me once the device that holds it is revoked", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const bot = yield* createBot("Ana");
    const ref = yield* open(bot.id, "https://shop.example.test/");
    const phone = yield* operatorDevice("Phone");
    const control = Option.getOrThrow(yield* browser.handsOf(ref)).control;
    assert.isTrue(yield* control.waitForMe(phone));
    yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref && tab.heldBy !== null));

    yield* (yield* DeviceAuth).revoke(phone);
    yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref && tab.heldBy === null));
  }).pipe(Effect.provide(TestDomain.layer)),
);
