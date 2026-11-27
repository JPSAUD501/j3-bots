// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BrowserCookie,
  type BrowserHostCapabilities,
  type BrowserSignIns,
  DeviceId,
} from "@j3-bots/contracts";
import { type FakePageHost, makeFakePageHost } from "@j3-bots/browser/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
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

const EVENTS: BrowserHostCapabilities = {
  cookies: true,
  storage: true,
  changeEvents: true,
};
const READ_ONLY_AGAIN: BrowserHostCapabilities = { cookies: true, storage: true };

/** A jar in a new folder, under a new key, and the sign-ins over it. */
const signInsIn = Effect.fn(function* (folder?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const where = folder ?? (yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" }));
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const jar = yield* openJarFile(path.join(where, "signins.sqlite"), key).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  return yield* makeSignIns({ jar, digests: makeDigests(key) });
});

type Signins = Effect.Success<ReturnType<typeof signInsIn>>;

/** Attaches `host` until `detach`. */
const attach = Effect.fn(function* (signIns: Signins, host: FakePageHost) {
  const scope = yield* Scope.make();
  const hello = yield* host.hello;
  const attached: SignInsAttachment = yield* signIns.attach(host, hello).pipe(Scope.provide(scope));
  return { ...attached, detach: Scope.close(scope, Exit.void) };
});

const host = (capabilities: BrowserHostCapabilities, cookieStore?: string) =>
  makeFakePageHost({
    host: { kind: "desktop", device: DeviceId.make("device-1") },
    capabilities,
    ...(cookieStore === undefined ? {} : { cookieStore }),
  });

/** What `host` holds, by name and value. */
const held = (on: FakePageHost) =>
  Effect.map(on.cookies, (cookies) => cookies.map(({ name, value }) => `${name}=${value}`).sort());

const writes = (on: FakePageHost) =>
  Effect.map(on.calls, (calls) => calls.filter(({ call }) => call === "cookies.write").length);

const sitesOf = (signIns: Signins) =>
  Effect.map(
    Stream.runHead(signIns.view),
    Option.getOrElse((): BrowserSignIns => ({ status: "unreadable", sites: [] })),
  );

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

it.layer(NodeServices.layer)("the shared sign-ins", (it) => {
  it.effect("a cookie one host's site sets reaches the others, and its echo changes nothing", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      yield* attach(signIns, b);

      yield* siteSets(a, onA, cookie("sid", "one", "mail.x.test"));
      assert.deepStrictEqual(yield* held(b), ["sid=one"]);
      assert.deepStrictEqual((yield* sitesOf(signIns)).sites, [{ site: "x.test" }]);

      // Chromium replaces a cookie as a removal and a set in one batch: the
      // others get the new value, and lose nothing.
      const next = cookie("sid", "two", "mail.x.test");
      yield* a.siteCookies({ set: [next], removed: [keyOfCookie(next)] });
      yield* onA.event({
        type: "cookies.changed",
        changes: { set: [next], removed: [keyOfCookie(next)] },
      });
      assert.deepStrictEqual(yield* held(b), ["sid=two"]);

      // A's write coming back from B as B's own change moves nothing.
      const before = yield* writes(a);
      const onB = yield* attach(signIns, b);
      yield* onB.event({ type: "cookies.changed", changes: { set: [next], removed: [] } });
      assert.strictEqual(yield* writes(a), before);
      assert.deepStrictEqual(yield* held(a), ["sid=two"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a host that restarts gets back the session cookies it lost", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const onA = yield* attach(signIns, a);
      yield* siteSets(
        a,
        onA,
        sessionCookie("session", "s", "x.test"),
        cookie("remember", "r", "x.test"),
      );
      yield* onA.detach;

      yield* a.restart;
      assert.deepStrictEqual(yield* held(a), ["remember=r"]);
      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["remember=r", "session=s"]);
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
      yield* siteSets(a, onA, cookie("sid", "one", "x.test"), cookie("theme", "dark", "y.test"));
      yield* onA.detach;

      yield* a.siteCookies({ set: [cookie("sid", "renewed", "x.test")], removed: [] });
      yield* signIns.signOutSite("x.test");
      assert.deepStrictEqual(yield* held(b), ["theme=dark"]);
      assert.deepStrictEqual((yield* sitesOf(signIns)).sites, [{ site: "y.test" }]);

      yield* attach(signIns, a);
      assert.deepStrictEqual(yield* held(a), ["theme=dark"]);
      assert.deepStrictEqual(yield* held(b), ["theme=dark"]);
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
    }).pipe(Effect.scoped),
  );

  it.effect("a site's storage reaches the other hosts, the origin a tab opens first", () =>
    Effect.gen(function* () {
      const signIns = yield* signInsIn();
      const a = yield* host(EVENTS, "store-a-0000000000");
      const b = yield* host(EVENTS, "store-b-0000000000");
      const onA = yield* attach(signIns, a);
      const onB = yield* attach(signIns, b);
      const saved = {
        origin: "https://app.x.test",
        localStorage: [{ name: "token", value: "t1" }],
      };
      yield* a.siteStorage(saved);
      yield* onA.event({ type: "storage.changed", origins: [saved.origin] });
      assert.deepStrictEqual(yield* b.storage, [saved]);

      yield* onB.detach;
      const renewed = { ...saved, localStorage: [{ name: "token", value: "t2" }] };
      yield* a.siteStorage(renewed);
      yield* onA.event({ type: "storage.changed", origins: [saved.origin] });
      const again = yield* attach(signIns, b);
      yield* again.prepare(`${saved.origin}/inbox`);
      assert.deepStrictEqual(yield* b.storage, [renewed]);
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
      // One the jar has not heard of yet goes too.
      yield* b.siteCookies({ set: [cookie("late", "l", "z.test")], removed: [] });

      yield* signIns.signOut;
      assert.deepStrictEqual(yield* held(a), []);
      assert.deepStrictEqual(yield* held(b), []);
      assert.deepStrictEqual(yield* sitesOf(signIns), { status: "ready", sites: [] });
    }).pipe(Effect.scoped),
  );
});
