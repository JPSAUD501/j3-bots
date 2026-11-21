// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { privateKeysIn } from "./sshKeys.ts";

it.layer(NodeServices.layer)("SSH private keys", (it) => {
  it.effect(
    "names the regular files that begin with a private key's header, and follows no link",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const ssh = path.join(root, ".ssh");
        yield* fs.makeDirectory(path.join(ssh, "old"), { recursive: true });
        const write = (name: string, text: string) =>
          fs.writeFileString(path.join(ssh, name), text);
        yield* write("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n");
        yield* write("legacy.pem", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n");
        yield* write("id_ed25519.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 someone@example\n");
        yield* write("notes", "the key starts with -----BEGIN OPENSSH PRIVATE KEY-----\n");
        yield* write("old/id_rsa", "-----BEGIN RSA PRIVATE KEY-----\n");
        yield* fs.symlink(path.join(ssh, "id_ed25519"), path.join(ssh, "linked"));

        assert.deepStrictEqual(yield* privateKeysIn(ssh), [
          path.join(ssh, "id_ed25519"),
          path.join(ssh, "legacy.pem"),
        ]);

        // A `~/.ssh` that is itself a link is not looked into.
        yield* fs.symlink(ssh, path.join(root, "linked-ssh"));
        assert.deepStrictEqual(yield* privateKeysIn(path.join(root, "linked-ssh")), []);
      }).pipe(Effect.scoped),
  );
});
