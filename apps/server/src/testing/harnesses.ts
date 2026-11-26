// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { type Distribution, onlyTo } from "../harnesses/distributions.ts";
import { HarnessFailed } from "../harnesses/failure.ts";
import { HarnessSources } from "../harnesses/sources.ts";

/** A distribution that ships nothing for this machine, and answers nothing: no test reaches the network. */
const nothing: Distribution = {
  origin: "https://harnesses.invalid",
  installable: false,
  latest: Effect.fail(new HarnessFailed({ reason: "unreachable" })),
  client: onlyTo(["https://harnesses.invalid"])(
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
    ),
  ),
};

/**
 * Harness sources as a test that is not about them sees them: nothing to
 * install, and no harness of the operator's, whatever the machine running
 * the test has on its `PATH`.
 */
export const layer = Layer.succeed(
  HarnessSources,
  HarnessSources.of({
    platform: "linux",
    distributions: { "claude-code": nothing, codex: nothing },
    probe: () => () => Effect.succeedNone,
    onPath: () => Effect.succeed(false),
  }),
);
