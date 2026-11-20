// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TEST_TLS } from "../testing/tls.ts";
import * as Tls from "./Tls.ts";

it.layer(NodeServices.layer)("TLS", (it) => {
  it.effect("offers clients only the certificate's concrete names, not its wildcards", () =>
    Effect.gen(function* () {
      const credentials = yield* Tls.load({ certPath: TEST_TLS.cert, keyPath: TEST_TLS.key });
      assert.deepStrictEqual(credentials.names, [TEST_TLS.name]);
    }),
  );
});
