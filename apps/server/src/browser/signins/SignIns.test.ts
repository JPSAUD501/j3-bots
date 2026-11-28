// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BrowserCookie,
  type BrowserHostCapabilities,
  type BrowserOriginStorage,
  type BrowserSignIns,
  BrowserTabRef,
  DeviceId,
} from "@j3-bots/contracts";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import { keyOfCookie, makeDigests } from "./canonical.ts";
import { openJarFile } from "./JarFile.ts";
import { makeSignIns, type SignInsAttachment } from "./SignIns.ts";

// The sync of the shared sign-ins against fake hosts in memory, over a jar
// in a temporary file. A fake host with change events reports nothing on
// its own here: each test hands the attachment the event a real host would
// send, so what reaches the jar, and when, is the test's to say.

/** Far in the future, in Unix seconds: a cookie that lasts. */
const LASTS = 4_000_000_000;

const cookie = (name: string, value: string, domain: string): BrowserCookie => ({
  name,
  value,
  domain,
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "unspecified",
  expires: LASTS,
});

/** A cookie that lasts until the browser closes. */
const sessionCookie = (name: string, value: string, domain: string): BrowserCookie => {
  const { expires: _expires, ...session } = cookie(name, value, domain);
  return session;
};

const stored = (origin: string, token: string): BrowserOriginStorage => ({
  origin,
  localStorage: [{ name: "token", value: token }],
});

const EVENTS: BrowserHostCapabilities = {
  cookies: true,
  storage: true,
  changeEvents: true,
};
const READ_ONLY_AGAIN: BrowserHostCapabilities = { cookies: true, storage: true };

/** A new key for a jar. */
const newKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** A jar in `folder`, or a new one, under `key`, or a new one, and the sign-ins over it. */
const signInsIn = Effect.fn(function* (folder?: string, key = newKey()) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const where = folder ?? (yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" }));
  const jar = yield* openJarFile(path.join(where, "signins.sqlite"), key).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  return yield* makeSignIns({ jar, digests: makeDigests(key) });
});

type Signins = Effect.Success<ReturnType<typeof signInsIn>>;

/** Attaches `host` until `detach`, or the test's end. */
const attach = Effect.fn(function* (signIns: Signins, host: FakePageHost) {
  const scope = yield* Scope.fork(yield* Scope.Scope);
  const hello = yield* host.hello;
  const attached: SignInsAttachment = yield* signIns.attach(host, hello).pipe(Scope.provide(scope));
  yield* settle;
  return { ...attached, detach: Scope.close(scope, Exit.void) };
});

/** Lets the sign-ins' work in the background, an origin's reconcile or a retry, run to its end. */
const settle = Effect.repeat(Effect.yieldNow, { times: 100 });

const host = (capabilities: BrowserHostCapabilities, cookieStore?: string) =>
  makeFakePageHost({
    host: { kind: "desktop", device: DeviceId.make("device-1") },
    capabilities,
    ...(cookieStore === undefined ? {} : { cookieStore }),
  });

/** A shared tab of the host shows `url`, loaded. */
const visits = (attached: SignInsAttachment, url: string, tab = "tab-1") =>
  attached.event({
    type: "tab.changed",
    page: {
      tab: BrowserTabRef.make(tab),
      url,
      title: "",
      loading: false,
      loadError: null,
      dialog: null,
    },
  });

/** What `host` holds, by name and value. */
const held = (on: FakePageHost) =>
  Effect.map(on.cookies, (cookies) => cookies.map(({ name, value }) => `${name}=${value}`).sort());

/** The tokens `host` keeps, by origin, leaving out origins that keep none. */
const tokens = (on: FakePageHost) =>
  Effect.map(on.storage, (origins) =>
    origins
      .filter((origin) => origin.localStorage.length > 0)
      .map((origin) => `${origin.origin}=${origin.localStorage.map(({ value }) => value).join()}`)
      .sort(),
  );

const writes = (on: FakePageHost) =>
  Effect.map(on.calls, (calls) => calls.filter(({ call }) => call === "cookies.write").length);

const sitesOf = (signIns: Signins) =>
  Effect.map(
    Stream.runHead(signIns.view),
    Option.getOrElse((): BrowserSignIns => ({ status: "unreadable", sites: [] })),
  );

const listed = (signIns: Signins) =>
  Effect.map(sitesOf(signIns), ({ sites }) => sites.map(({ site }) => site));

/** The host's site sets cookies, and the host reports it. */
const siteSets = (
  on: FakePageHost,
  attached: SignInsAttachment,
  ...cookies: ReadonlyArray<BrowserCookie>
) =>
  on
    .siteCookies({ set: cookies, removed: [] })
    .pipe(
      Effect.andThen(
        attached.event({ type: "cookies.changed", changes: { set: cookies, removed: [] } }),
      ),
    );

/** The host's site keeps `storage`, and the host reports it. */
const siteKeeps = (on: FakePageHost, attached: SignInsAttachment, storage: BrowserOriginStorage) =>
  on
    .siteStorage(storage)
    .pipe(Effect.andThen(attached.event({ type: "storage.changed", origins: [storage.origin] })));

it.layer(NodeServices.layer)("the shared sign-ins", (it) => {
  it.effect("a cookie one host's site sets reaches the others, and its echo changes nothing", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);

      // The page is the site's; the tracker it embeds sets a cookie too, and
      // is not a site the person signed in to.
      yield* visits(onA, "https://mail.x.test/inbox");
      yield* siteSets(a, onA, cookie("sid", "one", "mail.x.test"), cookie("uid", "u", "ads.test"));
      assert.deepStrictEqual(yield* held(b), ["sid=one", "uid=u"]);
      assert.deepStrictEqual(yield* listed(signIns), ["x.test"]);

      // Chromium replaces a cookie as a removal and a set in one batch: the
      // others get the new value, and lose nothing.
      const next = cookie("sid", "two", "mail.x.test");
      yield* a.siteCookies({ set: [next], removed: [keyOfCookie(next)] });
      yield* onA.event({
        type: "cookies.changed",
        changes: { set: [next], removed: [keyOfCookie(next)] },
      });
      assert.deepStrictEqual(yield* held(b), ["sid=two", "uid=u"]);

      // A's write coming back from B as B's own change moves nothing.
      const before = yield* writes(a);
      const onB = yield* attach(signIns, b);
      yield* onB.event({ type: "cookies.changed", changes: { set: [next], removed: [] } });
      assert.strictEqual(yield* writes(a), before);
      assert.deepStrictEqual(yield* held(a), ["sid=two", "uid=u"]);
    }).pipe(Effect.scoped),
  );

  it.effect("cookies one partition keeps apart reach the other hosts apart", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);
      const partitioned = (value: string, hasCrossSiteAncestor: boolean): BrowserCookie => ({
        ...cookie("chat", value, "widget.test"),
        partition: { topLevelSite: "https://x.test", hasCrossSiteAncestor },
      });
      yield* siteSets(a, onA, partitioned("top", false), partitioned("nested", true));
      assert.deepStrictEqual(yield* held(b), ["chat=nested", "chat=top"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a host that restarts gets back the session cookies it lost, as renewed since", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      const onB = yield* attach(signIns, b);
      yield* siteSets(
        a,
        onA,
        sessionCookie("session", "s1", "x.test"),
        cookie("remember", "r", "x.test"),
      );
      yield* onA.detach;
      // Another host's site renews the session while A is away.
      yield* siteSets(b, onB, sessionCookie("session", "s2", "x.test"));

      yield* a.restart;
      assert.deepStrictEqual(yield* held(a), ["remember=r"]);
      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["remember=r", "session=s2"]);
      assert.deepStrictEqual(yield* held(b), ["remember=r", "session=s2"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "what a host changed while away goes to the jar, and what the jar changed goes to it",
    () =>
      Effect.gen(function* () {
        const signIns = yield* signInsIn();
        const a = yield* host(EVENTS, "store-a-0000000000");
        const b = yield* host(EVENTS, "store-b-0000000000");
        const onA = yield* attach(signIns, a);
        const onB = yield* attach(signIns, b);
        yield* siteSets(a, onA, cookie("sid", "one", "x.test"), cookie("gone", "g", "x.test"));
        yield* onA.detach;

        // Away: its site renews one cookie and removes another, and nothing hears it.
        yield* a.siteCookies({
          set: [cookie("sid", "renewed", "x.test")],
          removed: [keyOfCookie(cookie("gone", "g", "x.test"))],
        });
        yield* siteSets(b, onB, cookie("theme", "dark", "y.test"));

        yield* attach(signIns, a);
        assert.deepStrictEqual(yield* held(a), ["sid=renewed", "theme=dark"]);
        assert.deepStrictEqual(yield* held(b), ["sid=renewed", "theme=dark"]);
      }).pipe(Effect.scoped),
  );

  it.effect("signing out of a site wins over what a host that was away changed", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);
      yield* visits(onA, "https://x.test/");
      yield* visits(onA, "https://y.test/");
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"), cookie("theme", "dark", "y.test"));
      yield* siteKeeps(a, onA, stored("https://x.test", "t1"));
      yield* onA.detach;

      yield* a.siteCookies({ set: [cookie("sid", "renewed", "x.test")], removed: [] });
      yield* a.siteStorage(stored("https://x.test", "t2"));
      yield* signIns.signOutSite("x.test");
      assert.deepStrictEqual(yield* held(b), ["theme=dark"]);
      assert.deepStrictEqual(yield* tokens(b), []);
      assert.deepStrictEqual(yield* listed(signIns), ["y.test"]);

      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["theme=dark"]);
      assert.deepStrictEqual(yield* tokens(a), []);
      assert.deepStrictEqual(yield* held(b), ["theme=dark"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a sign-out a host failed to take reaches it when it is synced again", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(signIns, a);
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"));
      yield* siteKeeps(a, onA, stored("https://x.test", "t1"));

      yield* a.failNext("storage.clear");
      yield* signIns.signOutSite("x.test");
      assert.deepStrictEqual(yield* tokens(a), ["https://x.test=t1"]);
      // Meanwhile its site's report of what it kept is not taken.
      yield* onA.event({ type: "storage.changed", origins: ["https://x.test"] });

      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.deepStrictEqual(yield* held(a), []);
      assert.deepStrictEqual(yield* tokens(a), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a host that was away has everything its signed-out sites stored cleared", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(signIns, a);
      yield* visits(onA, "https://x.test/");
      yield* siteKeeps(a, onA, stored("https://x.test", "t1"));
      yield* onA.detach;

      // Meanwhile its site keeps more than the jar syncs.
      yield* a.siteStorage({ ...stored("https://x.test", "t2"), indexedDb: [] });
      yield* signIns.signOutSite("x.test");
      yield* attach(signIns, a);
      const origins = yield* Effect.map(a.storage, (kept) => kept.map(({ origin }) => origin));
      assert.notInclude(origins, "https://x.test");
    }).pipe(Effect.scoped),
  );

  it.effect("a report a host queued before a slow sign-out does not sign back in", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);
      yield* visits(onA, "https://x.test/");
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"));

      const release = yield* a.holdNext("storage.clear");
      const signingOut = yield* Effect.forkChild(signIns.signOutSite("x.test"));
      yield* settle;
      yield* TestClock.adjust("11 seconds");
      yield* release;
      yield* Fiber.join(signingOut);
      // The report the host sent before the clear, delivered only now.
      yield* onA.event({
        type: "cookies.changed",
        changes: { set: [cookie("sid", "one", "x.test")], removed: [] },
      });
      assert.deepStrictEqual(yield* held(b), []);
      assert.deepStrictEqual(yield* listed(signIns), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a host's report from before the server's write to it does not undo the write", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      const onB = yield* attach(signIns, b);
      yield* a.siteCookies({ set: [cookie("sid", "from-a", "x.test")], removed: [] });
      yield* siteSets(b, onB, cookie("sid", "from-b", "x.test"));
      // A's report of its own renewal, sent before B's reached it.
      yield* onA.event({
        type: "cookies.changed",
        changes: { set: [cookie("sid", "from-a", "x.test")], removed: [] },
      });
      assert.deepStrictEqual(yield* held(a), ["sid=from-b"]);
      assert.deepStrictEqual(yield* held(b), ["sid=from-b"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a sign-out goes on to its end when whoever asked for it stops waiting", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(signIns, a);
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"));

      const release = yield* a.holdNext("cookies.read");
      const asked = yield* Effect.forkChild(signIns.signOutSite("x.test"));
      yield* settle;
      yield* Fiber.interrupt(asked);
      yield* release;
      yield* settle;
      assert.deepStrictEqual(yield* held(a), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a host's report sent before it took a sign-out does not sign back in", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);
      yield* visits(onA, "https://x.test/");
      const signedIn = cookie("sid", "one", "x.test");
      yield* siteSets(a, onA, signedIn);

      yield* signIns.signOutSite("x.test");
      yield* onA.event({ type: "cookies.changed", changes: { set: [signedIn], removed: [] } });
      assert.deepStrictEqual(yield* held(b), []);
      assert.deepStrictEqual(yield* listed(signIns), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a host new to the jar adds what it holds, but not a cookie the jar removed", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(signIns, a);
      const old = cookie("sid", "old", "x.test");
      yield* siteSets(a, onA, old, cookie("theme", "dark", "y.test"));
      yield* a.siteCookies({ set: [], removed: [keyOfCookie(old)] });
      yield* onA.event({
        type: "cookies.changed",
        changes: { set: [], removed: [keyOfCookie(old)] },
      });

      // A store the jar never saw: a desktop's, made again after it was signed out.
      const fresh = yield* host(EVENTS, "store-n-0000000000");
      yield* fresh.siteCookies({
        set: [old, cookie("lang", "pt", "z.test"), cookie("theme", "light", "y.test")],
        removed: [],
      });
      yield* attach(signIns, fresh);
      assert.deepStrictEqual(yield* held(fresh), ["lang=pt", "theme=dark"]);
      assert.deepStrictEqual(yield* held(a), ["lang=pt", "theme=dark"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a host without change events is read again before it closes", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const desktop = yield* host(EVENTS, "store-a-0000000000");
      const server = yield* host(READ_ONLY_AGAIN);
      yield* attach(signIns, desktop);
      const onServer = yield* attach(signIns, server);

      yield* server.siteCookies({ set: [sessionCookie("sid", "one", "x.test")], removed: [] });
      yield* onServer.flush;
      assert.deepStrictEqual(yield* held(desktop), ["sid=one"]);

      // In one run of its browser, a session cookie that is gone was removed by its site.
      yield* server.siteCookies({
        set: [],
        removed: [keyOfCookie(sessionCookie("sid", "one", "x.test"))],
      });
      yield* onServer.flush;
      assert.deepStrictEqual(yield* held(desktop), []);

      // What the last tab's site kept is read once more after the tab closes.
      yield* visits(onServer, "https://app.x.test/", "tab-9");
      yield* server.siteStorage(stored("https://app.x.test", "t1"));
      yield* onServer.event({
        type: "tab.closed",
        tab: BrowserTabRef.make("tab-9"),
        crashed: false,
      });
      yield* onServer.flush;
      assert.deepStrictEqual(yield* tokens(desktop), ["https://app.x.test=t1"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a site's storage reaches the other hosts, the origin a tab opens first", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      const onB = yield* attach(signIns, b);
      const saved = stored("https://app.x.test", "t1");
      yield* siteKeeps(a, onA, saved);
      assert.deepStrictEqual(yield* b.storage, [saved]);

      yield* onB.detach;
      const renewed = stored("https://app.x.test", "t2");
      yield* siteKeeps(a, onA, renewed);
      // B's page reports what it still keeps, from before: the jar's newer
      // storage wins over it, whichever comes first.
      const again = yield* attach(signIns, b);
      yield* again.event({ type: "storage.changed", origins: [saved.origin] });
      yield* again.prepare(`${saved.origin}/inbox`);
      assert.deepStrictEqual(yield* b.storage, [renewed]);
      assert.deepStrictEqual(yield* a.storage, [renewed]);
    }).pipe(Effect.scoped),
  );

  it.effect("signing out of all sites empties every host it can reach, and the jar", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"), cookie("theme", "dark", "y.test"));
      yield* siteKeeps(a, onA, stored("https://x.test", "t1"));
      // What the jar has not heard of yet goes too.
      yield* b.siteCookies({ set: [cookie("late", "l", "z.test")], removed: [] });
      yield* b.siteStorage(stored("https://z.test", "t9"));
      // A store away now, new to the jar when it comes back.
      const away = yield* host(EVENTS, "store-n-0000000000");
      yield* away.siteCookies({ set: [cookie("sid", "kept", "x.test")], removed: [] });

      yield* signIns.signOut;
      assert.deepStrictEqual(yield* held(a), []);
      assert.deepStrictEqual(yield* held(b), []);
      assert.deepStrictEqual(yield* tokens(a), []);
      assert.deepStrictEqual(yield* tokens(b), []);
      assert.deepStrictEqual(yield* sitesOf(signIns), { status: "ready", sites: [] });

      yield* attach(signIns, away);
      assert.deepStrictEqual(yield* held(away), []);
      assert.deepStrictEqual(yield* held(a), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a store away over 90 days after a sign-out of all comes back empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" });
      const key = newKey();
      const before = yield* signInsIn(folder, key);
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(before, a);
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"));
      yield* onA.detach;

      yield* TestClock.adjust("2 days");
      yield* before.signOut;
      yield* TestClock.adjust("98 days");
      // The next start drops what the store held, and keeps its version.
      const signIns = yield* signInsIn(folder, key);
      const b = yield* host(EVENTS, "store-b-0000000000");
      yield* attach(signIns, b);
      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), []);
      assert.deepStrictEqual(yield* held(b), []);
    }).pipe(Effect.scoped),
  );

  it.effect("signing out of all sites starts an unreadable jar again, and empties its hosts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" });
      yield* signInsIn(folder);
      const signIns = yield* signInsIn(folder);
      assert.strictEqual((yield* sitesOf(signIns)).status, "unreadable");

      const a = yield* host(EVENTS, "store-a-0000000000");
      yield* a.siteCookies({ set: [cookie("sid", "one", "x.test")], removed: [] });
      yield* a.siteStorage(stored("https://x.test", "t1"));
      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["sid=one"]);

      yield* signIns.signOut;
      assert.deepStrictEqual(yield* held(a), []);
      assert.deepStrictEqual(yield* tokens(a), []);
      assert.strictEqual((yield* sitesOf(signIns)).status, "ready");
      // The engine's sign-ins of before, still to move, are from before too.
      yield* signIns.bringIn({ cookies: [cookie("sid", "old", "x.test")], origins: [], sites: [] });
      assert.deepStrictEqual(yield* held(a), []);
      assert.strictEqual(yield* signIns.toBringIn, "done");
    }).pipe(Effect.scoped),
  );

  it.effect("the sign-ins of before are brought in once, without the sites signed out of", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      yield* signIns.signOutSite("x.test");
      yield* signIns.bringIn({
        cookies: [cookie("sid", "old", "x.test"), cookie("sid", "old", "y.test")],
        origins: [
          { indexedDb: false, storage: stored("https://x.test", "t0") },
          { indexedDb: false, storage: stored("https://y.test", "t0") },
        ],
        sites: ["x.test", "y.test"],
      });
      assert.deepStrictEqual(yield* listed(signIns), ["y.test"]);
      assert.strictEqual(yield* signIns.toBringIn, "done");

      const a = yield* host(EVENTS, "store-a-0000000000");
      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["sid=old"]);
      assert.deepStrictEqual(yield* tokens(a), ["https://y.test=t0"]);
    }).pipe(Effect.scoped),
  );
});
