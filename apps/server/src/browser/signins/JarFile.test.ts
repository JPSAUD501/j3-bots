// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { BrowserCookie } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { keyOfCookie, makeDigests } from "./canonical.ts";
import { openJarFile } from "./JarFile.ts";

// The sign-ins' file: sealed under its key, so it names no site and holds
// no value a reader of the disk could take, and opens under that key alone;
// a file that does not open leaves the jar unreadable, never the server
// stopped, until a reset makes it again.

const SITE = "jar-proof.test";
const VALUE = "the-session-value-7f3a";
const TOKEN = "the-stored-token-91c2";

const signedIn: BrowserCookie = {
  name: "sid",
  value: VALUE,
  domain: SITE,
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: 4_000_000_000,
};
const removed: BrowserCookie = { ...signedIn, name: "old", value: "the-removed-value" };

const newKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

const openAt = (location: string, key: Uint8Array) =>
  openJarFile(location, key).pipe(Effect.provide(SecureRandom.layerWebCrypto), Effect.scoped);

/** Every byte of the folder's files: the database, and its log beside it. */
const bytesIn = Effect.fn(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(folder);
  const files = yield* Effect.forEach(names, (name) => fs.readFile(path.join(folder, name)));
  return Buffer.concat(files.map((bytes) => Buffer.from(bytes))).toString("latin1");
});

it.layer(NodeServices.layer)("the sign-ins' file", (it) => {
  it.effect("names no site and holds no value in the clear, and opens under its key alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-jar-" });
      const location = path.join(folder, "signins.sqlite");
      const key = newKey();
      const digests = makeDigests(key);
      const origin = `https://${SITE}`;

      yield* openJarFile(location, key).pipe(
        Effect.flatMap((opened) =>
          opened._tag === "open"
            ? opened.file.commit({
                version: 1,
                cookies: {
                  set: [
                    [digests.cookieId(keyOfCookie(signedIn)), signedIn],
                    [digests.cookieId(keyOfCookie(removed)), removed],
                  ],
                  removed: [],
                },
                origins: [
                  [
                    digests.originId(origin),
                    { storage: { origin, localStorage: [{ name: "token", value: TOKEN }] } },
                  ],
                ],
                signouts: [[digests.siteId("other.test"), 1]],
                sites: { set: [[digests.siteId(SITE), SITE]], removed: [] },
              })
            : Effect.die(new Error("A new jar should open.")),
        ),
        Effect.andThen(
          openJarFile(location, key).pipe(
            Effect.flatMap((opened) =>
              opened._tag === "open"
                ? opened.file.commit({
                    version: 2,
                    cookies: {
                      set: [],
                      removed: [
                        [digests.cookieId(keyOfCookie(removed)), digests.cookieDigest(removed)],
                      ],
                    },
                  })
                : Effect.die(new Error("The jar should open under its key.")),
            ),
          ),
        ),
        Effect.provide(SecureRandom.layerWebCrypto),
        Effect.scoped,
      );

      const disk = yield* bytesIn(folder);
      for (const clear of [SITE, VALUE, TOKEN, "other.test", "the-removed-value"])
        assert.isFalse(disk.includes(clear), `${clear} is on the disk in the clear`);

      const reopened = yield* openAt(location, key);
      assert.strictEqual(reopened._tag, "open");
      if (reopened._tag === "open") {
        const { contents } = reopened;
        assert.strictEqual(contents.version, 2);
        assert.deepStrictEqual([...contents.cookies.values()], [signedIn]);
        assert.deepStrictEqual(
          [...contents.tombstones],
          [[digests.cookieId(keyOfCookie(removed)), digests.cookieDigest(removed)]],
        );
        assert.deepStrictEqual(
          [...contents.origins.values()].map(({ storage }) => storage.localStorage),
          [[{ name: "token", value: TOKEN }]],
        );
        assert.deepStrictEqual([...contents.sites.values()], [SITE]);
      }

      const other = yield* openAt(location, newKey());
      assert.strictEqual(other._tag, "unreadable");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["sealed under another key", "key"],
    ["damaged", "damaged"],
  ] as const)("is unreadable when %s, and starts again, empty, when it is reset", ([, how]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-jar-" });
      const location = path.join(folder, "signins.sqlite");
      if (how === "key") yield* openAt(location, newKey());
      else yield* fs.writeFileString(location, "not a database, though it says it is one");

      const key = newKey();
      const reset = yield* openJarFile(location, key).pipe(
        Effect.flatMap((opened) =>
          opened._tag === "unreadable"
            ? opened.reset
            : Effect.die(new Error("The jar should not open.")),
        ),
        Effect.provide(SecureRandom.layerWebCrypto),
        Effect.scoped,
      );
      assert.strictEqual(reset.contents.cookies.size, 0);
      assert.isDefined(reset.contents.clearedAt);
      const reopened = yield* openAt(location, key);
      assert.strictEqual(reopened._tag, "open");
      if (reopened._tag === "open") assert.isDefined(reopened.contents.clearedAt);
    }).pipe(Effect.scoped),
  );
});
