// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readProfileSignIns } from "./profile.ts";
import { TEST_PROFILE_SITES, writeTestProfile } from "./testing/profiles.ts";

const { mail: MAIL, notes: NOTES } = TEST_PROFILE_SITES;

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

describe.skipIf(executablePath === undefined)("a profile's sign-ins", () => {
  it.live(
    "gives its cookies as they were set, and its sites' storage and databases, from a copy, with no history to find them by",
    () =>
      Effect.gen(function* () {
        if (executablePath === undefined) return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-old-profile-" });
        yield* writeTestProfile(profile, executablePath);
        // As `chrome-headless-shell` leaves a profile: with no history, so the
        // sites are found from their storage alone.
        yield* fs.remove(path.join(profile, "Default", "History"), { force: true });
        yield* fs.remove(path.join(profile, "Default", "History-journal"), { force: true });
        const cookieFile = path.join(profile, "Default", "Cookies");
        const before = yield* fs.readFile(cookieFile);
        const work = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "j3-move-" }), "copy");

        const read = yield* readProfileSignIns({ profile, executablePath, workFolder: work });

        const byName = new Map(read.cookies.map((cookie) => [cookie.name, cookie]));
        const remember = byName.get("remember");
        assert.deepStrictEqual(remember && { ...remember, expires: typeof remember.expires }, {
          name: "remember",
          value: "r1",
          domain: "example.test",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "strict",
          expires: "number",
        });
        const plain = byName.get("plain");
        assert.strictEqual(plain?.hostOnly, true);
        assert.strictEqual(plain?.domain, "mail.example.test");
        assert.strictEqual(plain?.sameSite, "unspecified");

        const byOrigin = new Map(read.origins.map((origin) => [origin.origin, origin]));
        const mail = byOrigin.get(MAIL);
        assert.deepStrictEqual(mail?.localStorage, [{ name: "token", value: "t1" }]);
        assert.deepStrictEqual(
          mail?.indexedDb?.map((database) => [database.name, database.version]),
          [["mail", 2]],
        );
        const notes = byOrigin.get(NOTES);
        assert.deepStrictEqual(notes, {
          origin: NOTES,
          localStorage: [{ name: "theme", value: "dark" }],
          indexedDb: [],
        });

        // Its pages, from their storage; not the domain of a cookie alone.
        assert.sameMembers([...read.visited], [MAIL, NOTES]);

        assert.deepStrictEqual(yield* fs.readFile(cookieFile), before);
        assert.isFalse(yield* fs.exists(work));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
