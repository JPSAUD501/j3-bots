// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import { launchServerHost, type ServerHost } from "../server/ServerHost.ts";
import { makeDigests } from "./canonical.ts";
import { openJarFile } from "./JarFile.ts";
import { makeSignIns } from "./SignIns.ts";

// A sign-in a site keeps only in IndexedDB, as Firebase's client does, made
// in one server browser and found in the next: through the jar, sealed in a
// temporary file. The site is a page this test serves on the loopback.

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

const DATABASE = "firebaseLocalStorageDb";
const STORE = "firebaseLocalStorage";

/** A Firebase-style client: the sign-in lives in IndexedDB alone, with no cookie. */
const APP = `<!doctype html><title>Fake app</title>
<p id="state">checking</p>
<script>
const KEY = "firebase:authUser:fake-api-key:[DEFAULT]";
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("${DATABASE}", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("${STORE}", { keyPath: "fbase_key" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const read = async () => {
  const db = await open();
  return new Promise((resolve) => {
    const request = db.transaction("${STORE}").objectStore("${STORE}").get(KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
};
window.signIn = async () => {
  const db = await open();
  await new Promise((resolve) => {
    const transaction = db.transaction("${STORE}", "readwrite");
    transaction.objectStore("${STORE}").put({
      fbase_key: KEY,
      value: { uid: "u-fake", email: "fake-user@example.test", signedInAt: new Date(0) },
    });
    transaction.oncomplete = resolve;
  });
  await show();
};
const show = async () => {
  const kept = await read();
  state.textContent = kept ? "Signed in as " + kept.value.email : "Signed out";
};
show();
</script>`;

/** The app's origin on the loopback, for as long as the scope lives. */
const appSite = Effect.gen(function* () {
  yield* HttpServer.serveEffect(
    Effect.succeed(HttpServerResponse.text(APP, { contentType: "text/html" })),
  );
  const { address } = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(address))
    return yield* Effect.die("The test server listens on TCP");
  return `http://127.0.0.1:${address.port}`;
});

/** `host` attached to `signIns`, its events going to them, until the scope closes. */
const attached = Effect.fn(function* (
  signIns: Effect.Success<ReturnType<typeof makeSignIns>>,
  host: ServerHost,
) {
  const attachment = yield* signIns.attach(host, yield* host.hello);
  yield* host.events.pipe(Stream.runForEach(attachment.event), Effect.forkScoped);
  return attachment;
});

const decodeText = Schema.decodeUnknownEffect(Schema.String);

/** What the app says of its sign-in, once it has looked. */
const stateOf = (host: ServerHost, tab: BrowserTabRef) =>
  host
    .evaluate({
      tab,
      expression: `new Promise((resolve) => {
        const look = () => state.textContent === "checking" ? setTimeout(look, 50) : resolve(state.textContent);
        look();
      })`,
      awaitPromise: true,
    })
    .pipe(Effect.flatMap(({ value }) => decodeText(value)));

describe.skipIf(executablePath === undefined)("a sign-in kept in IndexedDB", () => {
  it.live(
    "made in one server browser is still there in a fresh one, through the jar",
    () =>
      Effect.gen(function* () {
        if (executablePath === undefined) return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const origin = yield* appSite;
        const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-signins-" });
        const jar = yield* openJarFile(path.join(folder, "signins.sqlite"), key).pipe(
          Effect.provide(SecureRandom.layerWebCrypto),
        );
        const signIns = yield* makeSignIns({ jar, digests: makeDigests(key) });
        // The move brought the app's database in, signed out: the jar keeps
        // the origin's databases from then on.
        yield* signIns.bringIn({
          cookies: [],
          origins: [
            {
              indexedDb: true,
              storage: {
                origin,
                localStorage: [],
                indexedDb: [
                  {
                    name: DATABASE,
                    version: 1,
                    stores: [
                      {
                        name: STORE,
                        autoIncrement: false,
                        keyPath: "fbase_key",
                        records: [],
                        indexes: [],
                      },
                    ],
                  },
                ],
              },
            },
          ],
          sites: [],
        });
        const tab = BrowserTabRef.make("tab-1");
        const launch = { executable: executablePath, platform: "linux64" } as const;

        // The first browser: signed out, then signed in, then closed.
        const first = yield* Scope.make();
        const before = yield* launchServerHost(launch).pipe(Scope.provide(first));
        const onBefore = yield* attached(signIns, before).pipe(Scope.provide(first));
        yield* onBefore.prepare(`${origin}/`);
        yield* before.open({ tab, url: `${origin}/`, background: true, private: false });
        assert.strictEqual(yield* stateOf(before, tab), "Signed out");
        yield* before.evaluate({ tab, expression: "signIn()", awaitPromise: true });
        assert.strictEqual(yield* stateOf(before, tab), "Signed in as fake-user@example.test");
        yield* onBefore.flush;
        yield* Scope.close(first, Exit.void);

        // A fresh browser, with nothing of the first but what the jar kept.
        const after = yield* launchServerHost(launch);
        const onAfter = yield* attached(signIns, after);
        yield* onAfter.prepare(`${origin}/`);
        yield* after.open({ tab, url: `${origin}/`, background: true, private: false });
        assert.strictEqual(yield* stateOf(after, tab), "Signed in as fake-user@example.test");
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeHttpServer.layerTest])),
    120_000,
  );
});
