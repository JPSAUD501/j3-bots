// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { makePrivateFiles } from "./PrivateFiles.ts";

const machine = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto);

it.effect("removes only in a folder the check accepts, and a link itself, not where it leads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(outside, "owner-file"), "the owner's file");
    const exposed = path.join(home, "exposed");
    const link = path.join(home, "link");
    yield* fs.symlink(outside, exposed);
    yield* fs.symlink(outside, link);
    const files = yield* makePrivateFiles((location) => Effect.succeed(location !== exposed));

    const refused = yield* files.remove(path.join(exposed, "owner-file")).pipe(Effect.exit);
    const error = Exit.isFailure(refused) ? Exit.findErrorOption(refused) : Option.none();
    assert.deepInclude(Option.getOrUndefined(error), { _tag: "StorageExposed", location: exposed });

    yield* files.remove(link);
    assert.isFalse(yield* fs.exists(link));
    assert.deepStrictEqual(yield* fs.readDirectory(outside), ["owner-file"]);
  }).pipe(Effect.scoped, Effect.provide(machine)),
);

it.effect("checks a link's target from where its folder really is, links resolved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    yield* fs.makeDirectory(path.join(home, "shallow"));
    yield* fs.makeDirectory(path.join(home, "a", "b"), { recursive: true });
    // `a/b/deep` is `shallow`, one level nearer the top: `../../x` from it leaves the home.
    yield* fs.symlink(path.join(home, "shallow"), path.join(home, "a", "b", "deep"));
    const files = yield* makePrivateFiles((location) =>
      Effect.succeed(location === home || location.startsWith(`${home}/`)),
    );

    const location = path.join(home, "a", "b", "deep", "link");
    const refused = yield* files.link(location, "../../../x").pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(refused));
    assert.isFalse(yield* fs.exists(path.join(home, "shallow", "link")));

    yield* files.link(location, "../x");
    assert.strictEqual(yield* fs.readLink(path.join(home, "shallow", "link")), "../x");
  }).pipe(Effect.scoped, Effect.provide(machine)),
);
