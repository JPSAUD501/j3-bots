// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off -- The test sets a variable Node itself reads when it starts a child, in the folder it would name.
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  answerOf,
  fixtureOptions,
  OPERATOR_SECRET,
  SERVER_ONLY,
  serverEnvironment,
} from "../testing/stdioFixture.ts";
import { openCommandSession } from "./session.ts";

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

describe("openCommandSession", () => {
  it.live(
    "speaks MCP with the process, which gets only the allowed environment and the operator's",
    () =>
      Effect.gen(function* () {
        // Node hands this variable of its own to every child unless told otherwise.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env["NODE_V8_COVERAGE"] = NodePath.join(NodeOs.tmpdir(), "j3-coverage");
          }),
          () =>
            Effect.sync(() => {
              delete process.env["NODE_V8_COVERAGE"];
            }),
        );
        const { session } = yield* openCommandSession({
          ...fixtureOptions(["--tool", "extra"]),
          onToolsChanged: Effect.void,
        });
        // The line the fixture writes before any message is skipped.
        assert.includeMembers(
          (yield* session.listTools).map((tool) => tool.name),
          ["whoami", "environment", "echo", "extra"],
        );

        const names = decodeNames(yield* answerOf(session, "environment"));
        assert.include(names, "FIXTURE_SECRET");
        assert.include(names, "PATH");
        assert.notInclude(names, SERVER_ONLY);
        for (const name of names) {
          assert.isTrue(
            process.platform === "win32" ||
              ["FIXTURE_SECRET", "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"].includes(
                name,
              ),
            name,
          );
        }

        // A value the operator gave is scrubbed from what the server answers; its arguments are not.
        const echoed = yield* answerOf(session, "echo", { name: "FIXTURE_SECRET" });
        assert.notInclude(echoed, OPERATOR_SECRET);
        assert.include(echoed, "[redacted]");
        assert.deepStrictEqual(decodeNames(yield* answerOf(session, "arguments")), [
          "--tool",
          "extra",
        ]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live("starts nothing while the server's Node logs what it starts children with", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        openCommandSession({
          ...fixtureOptions(),
          serverEnvironment: { ...serverEnvironment, NODE_DEBUG: "net,child*" },
          onToolsChanged: Effect.void,
        }),
      );
      assert.strictEqual(
        failure._tag === "CommandFailed" ? failure.reason : failure._tag,
        "exited",
      );
    }).pipe(Effect.scoped),
  );
});
