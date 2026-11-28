// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import {
  type BotId,
  BrowserHostError,
  BrowserTabRef,
  DeviceId,
  MAX_ATTACHMENT_SIZE,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import { BROWSER_NOTES } from "@j3-bots/prompts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { operatorDevice, TestServerBrowser } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot } from "../testing/turns.ts";
import { Browser, DESKTOP_GRACE, SERVER_TAB_CAP } from "./Browser.ts";
import type { ServerBrowserUnavailable } from "./server/ServerBrowser.ts";
import { TabAccess } from "./TabAccess.ts";
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
    yield* (yield* Browser)
      .attachHost(host, yield* host.hello.pipe(Effect.orDie))
      .pipe(Scope.provide(scope));
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

it.effect("keeps a private pop-up from the bot whose tab opened it", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const bot = yield* createBot("Ana");
    const { host } = yield* desktop(laptop);
    const opener = yield* open(bot.id, "https://shop.example.test/");
    const popup = BrowserTabRef.make("tab-private-popup");
    const page = yield* host.open({ tab: popup, private: true, background: false });
    yield* host.emit({ type: "tab.opened", page, opener, private: true });
    yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === popup));
    // A call without a tab still works on the bot's own tab, never the private one.
    const read = yield* browser.tools.snapshot(bot.id, {}).pipe(Effect.orDie);
    assert.strictEqual(read.tab, opener);
    const shared = yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === popup));
    assert.deepStrictEqual(shared.find((tab) => tab.ref === popup)?.onIt, []);

    // What the private tab opens in turn is private, though its host says not.
    const next = BrowserTabRef.make("tab-from-private");
    const nextPage = yield* host.open({ tab: next, private: false, background: false });
    yield* host.emit({ type: "tab.opened", page: nextPage, opener: popup, private: false });
    const listed = yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === next));
    assert.isTrue(listed.find((tab) => tab.ref === next)?.private);
    const refused = yield* browser.tools.snapshot(bot.id, { tab: next }).pipe(Effect.flip);
    assert.strictEqual(refused.text, BROWSER_NOTES.noTab(next));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("acts on nothing a desktop's replaced connection still says", () =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const { host: stale } = yield* desktop(laptop);
    const ref = yield* open(bot.id, "https://shop.example.test/");
    // The same app connects again before the old connection has ended.
    const fresh = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
    yield* fresh.open({ tab: ref, private: false, background: false });
    yield* attach(fresh);

    yield* stale.emit({ type: "tab.closed", tab: ref, crashed: false });
    for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow;
    const tabs = yield* tabsWhen((all) => all.some((tab) => tab.ref === ref));
    assert.deepStrictEqual(
      tabs.map((tab) => tab.where),
      [{ kind: "desktop", device: laptop }],
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("gives a download to the bot whose action started it, not to one acting as it ends", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const ana = yield* createBot("Ana");
    const bea = yield* createBot("Bea");
    const { host } = yield* desktop(laptop);
    const ref = yield* open(ana.id, "https://files.example.test/");
    // Too large to keep, so its bot is told without a workspace to keep it in.
    const started = yield* host.startDownload(
      ref,
      "report.pdf",
      new Uint8Array(MAX_ATTACHMENT_SIZE + 1),
    );
    yield* TestClock.adjust(BOT_LEASE);
    yield* browser.tools.act(bea.id, ref, { action: "press", key: "Enter" }).pipe(Effect.orDie);
    yield* started.finish;
    while (!(yield* host.calls).some((call) => call.call === "download.take")) {
      yield* Effect.yieldNow;
    }

    const tooLarge = BROWSER_NOTES.downloadTooLarge("report.pdf");
    const anaRead = yield* browser.tools.snapshot(ana.id, { tab: ref }).pipe(Effect.orDie);
    assert.include(anaRead.notice ?? "", tooLarge);
    const beaRead = yield* browser.tools.snapshot(bea.id, { tab: ref }).pipe(Effect.orDie);
    assert.notInclude(beaRead.notice ?? "", tooLarge);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a new tab once every tab of the server's browser is in use", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const bot = yield* createBot("Ana");
    const phone = yield* operatorDevice("Phone");
    for (let n = 0; n < SERVER_TAB_CAP; n++) {
      const ref = yield* open(bot.id, `https://page${n}.example.test/`);
      const control = Option.getOrThrow(yield* browser.handsOf(ref)).control;
      assert.isTrue(yield* control.waitForMe(phone));
    }
    const refused = yield* browser.tools
      .open(bot.id, { url: "https://one-more.example.test/" })
      .pipe(Effect.flip);
    assert.strictEqual(refused.text, BROWSER_NOTES.serverFull);
    const running = yield* (yield* TestServerBrowser).running;
    assert.strictEqual((yield* running.tabs).length, SERVER_TAB_CAP);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("opens a parked tab once when two calls find it parked together", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const ana = yield* createBot("Ana");
    const bea = yield* createBot("Bea");
    const { attached } = yield* desktop(laptop);
    const ref = yield* open(ana.id, "https://news.example.test/");
    yield* Scope.close(attached, Exit.void);
    yield* TestClock.adjust(DESKTOP_GRACE);
    yield* tabsWhen((tabs) => tabs.some((tab) => tab.ref === ref && tab.where.kind === "parked"));

    // Another desktop, whose browser takes its time to open a tab.
    const fake = yield* makeFakePageHost({
      host: { kind: "desktop", device: DeviceId.make("device-desk") },
    });
    const gate = yield* Deferred.make<void>();
    yield* attach({
      ...fake,
      open: (input) => Effect.andThen(Deferred.await(gate), fake.open(input)),
    });
    const reads = yield* Effect.forEach(
      [ana, bea],
      (bot) => browser.tools.snapshot(bot.id, { tab: ref }).pipe(Effect.orDie),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(reads);
    const opens = (yield* fake.calls).filter(
      (call) => call.call === "tab.open" && call.tab === ref,
    );
    assert.strictEqual(opens.length, 1);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a fill whose tab lost its browser while the fill waited its turn", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const bot = yield* createBot("Ana");
    // A desktop whose browser holds a bot's action until the test lets it go.
    const fake = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
    const reached = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const attached = yield* attach({
      ...fake,
      act: (input) =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(fake.act(input)),
        ),
    });
    while (!(yield* fake.calls).some((call) => call.call === "host.events")) yield* Effect.yieldNow;
    const ref = yield* open(bot.id, "https://login.example.test/");
    const acting = yield* browser.tools
      .act(bot.id, ref, { action: "press", key: "Enter" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(reached);

    const hold = yield* (yield* TabAccess)
      .holdForFill(ref)
      .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
    // The fill finds the tab on its browser and waits for the bot's action.
    for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow;
    // The desktop goes: its tab has no browser, well within the fill's wait.
    yield* Scope.close(attached, Exit.void);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(acting).pipe(Effect.ignore);

    assert.strictEqual((yield* Fiber.join(hold)).reason, "unavailable");
    const hands = Option.getOrThrow(yield* browser.handsOf(ref));
    assert.notStrictEqual((yield* hands.control.state).holder?.kind, "fill");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("says why no tab opened for the person: no browser, an app-only server, a full one", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const server = yield* TestServerBrowser;
    const phone = yield* operatorDevice("Phone");
    const reasonOf = (problem: ServerBrowserUnavailable["reason"] | null) =>
      Effect.gen(function* () {
        yield* server.refuse(problem);
        const ref = BrowserTabRef.make(`tab-${problem ?? "full"}`);
        const refused = yield* browser
          .openForPerson({ device: phone, ref, url: "https://news.example.test/" })
          .pipe(Effect.flip);
        // Nothing is left behind of a tab that did not open.
        assert.isTrue(Option.isNone(yield* browser.handsOf(ref)));
        return refused.reason;
      });
    assert.strictEqual(yield* reasonOf("sandbox"), "browser-unavailable");
    assert.strictEqual(yield* reasonOf("failed"), "browser-unavailable");
    assert.strictEqual(yield* reasonOf("off"), "browser-app-only");
    assert.strictEqual(yield* reasonOf("platform"), "browser-app-only");

    const bot = yield* createBot("Ana");
    yield* server.refuse(null);
    for (let n = 0; n < SERVER_TAB_CAP; n++) {
      const ref = yield* open(bot.id, `https://page${n}.example.test/`);
      assert.isTrue(yield* Option.getOrThrow(yield* browser.handsOf(ref)).control.waitForMe(phone));
    }
    assert.strictEqual(yield* reasonOf(null), "browser-full");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("says why the browser that took the person's tab did not open its page", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const fake = yield* makeFakePageHost({ host: { kind: "desktop", device: laptop } });
    const failure = yield* Ref.make(new BrowserHostError({ reason: "timeout" }));
    yield* attach({ ...fake, open: () => Effect.flatMap(Ref.get(failure), Effect.fail) });
    const reasonOf = (error: BrowserHostError) =>
      Effect.gen(function* () {
        yield* Ref.set(failure, error);
        const ref = BrowserTabRef.make(`tab-${error.reason}`);
        const refused = yield* browser
          .openForPerson({ device: laptop, ref, url: "https://slow.example.test/" })
          .pipe(Effect.flip);
        assert.isTrue(Option.isNone(yield* browser.handsOf(ref)));
        return refused.reason;
      });
    assert.strictEqual(
      yield* reasonOf(new BrowserHostError({ reason: "timeout" })),
      "browser-page-timeout",
    );
    assert.strictEqual(
      yield* reasonOf(new BrowserHostError({ reason: "refused", detail: "Not that address." })),
      "browser-address-refused",
    );
    assert.strictEqual(
      yield* reasonOf(new BrowserHostError({ reason: "page", detail: "Target crashed." })),
      "browser-page-failed",
    );
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "lists a desktop's tab as away, with no host for its viewers, as soon as its app goes, and live again once it is back",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const bot = yield* createBot("Ana");
      const { host, attached } = yield* desktop(laptop);
      const ref = yield* open(bot.id, "https://news.example.test/");
      const watched = Option.getOrThrow(yield* browser.watch(ref));
      const hosts = yield* Queue.unbounded<Option.Option<unknown>>();
      yield* watched.host.pipe(
        Stream.runForEach((each) => Queue.offer(hosts, each)),
        Effect.forkScoped,
      );
      assert.isTrue(Option.isSome(yield* Queue.take(hosts)));

      yield* Scope.close(attached, Exit.void);
      // At once: no time passes.
      assert.isTrue(Option.isNone(yield* Queue.take(hosts)));
      yield* tabsWhen((tabs) =>
        tabs.some(
          (tab) => tab.ref === ref && tab.where.kind === "desktop" && tab.where.away === true,
        ),
      );

      yield* attach(host);
      assert.isTrue(Option.isSome(yield* Queue.take(hosts)));
      const back = yield* tabsWhen((tabs) =>
        tabs.some((tab) => tab.ref === ref && tab.where.kind === "desktop" && !tab.where.away),
      );
      assert.deepStrictEqual(back.find((tab) => tab.ref === ref)?.where, {
        kind: "desktop",
        device: laptop,
      });
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
