// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { answerOf, fixtureOptions, OPERATOR_SECRET, SERVER_ONLY } from "../testing/stdioFixture.ts";
import { openCommandSession } from "./session.ts";

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

describe("openCommandSession", () => {
  it.live(
    "speaks MCP with the process, which gets only the allowed environment and the operator's",
    () =>
      Effect.gen(function* () {
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
});
