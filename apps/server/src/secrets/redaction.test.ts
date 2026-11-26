// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { HTTP_PATHS, SecretId, SecretName, SecretsRpcs, SiteOrigin } from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Devices } from "../devices/Devices.ts";
import * as Http from "../http.ts";
import * as Listener from "../listener.ts";
import * as TestDomain from "../testing/domain.ts";
import * as TestUpdates from "../testing/update.ts";
import * as WebClient from "../web/WebClient.ts";

/** Every line the server logs while these tests run, at any level, as JSON. */
const logged: Array<string> = [];
const recordLogs = Layer.merge(
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

/** What a client could send as `secrets.openOldVault`, unchecked: a password of any length. */
const UncheckedRpcs = RpcGroup.make(
  Rpc.make("secrets.openOldVault", {
    payload: { password: Schema.String },
    success: Schema.Unknown,
  }),
);

const OLD_PASSWORD = "old-vault-password-value";
const USERNAME = "username-value@example.com";
const PASSWORD = "login-password-value";
const NEXT_PASSWORD = "next-password-value";
const TOTP = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TOKEN = "single-token-value";
const VALUES = [OLD_PASSWORD, USERNAME, PASSWORD, NEXT_PASSWORD, TOTP, TOKEN, "not-a-totp-value"];

// The client listener as the server runs it, on a port the system chooses.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provide(TestUpdates.layer),
    Layer.provideMerge(TestDomain.servedLayer),
  ),
  { excludeTestServices: true },
)("secrets' values over the socket", (it) => {
  it.effect("reach no log, no error and no answer but the one that reveals them", () =>
    Effect.gen(function* () {
      const devices = yield* Devices;
      const { code } = yield* devices.startPairing;
      const { token } = yield* devices.pair({ code, name: "Laptop" });
      const bound = yield* Deferred.await(yield* Listener.Listener);
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            NodeSocket.layerWebSocket(`ws://${bound.address}:${bound.port}${HTTP_PATHS.rpc}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      );
      const client = yield* RpcClient.make(SecretsRpcs).pipe(Effect.provide(protocol));
      const unchecked = yield* RpcClient.make(UncheckedRpcs).pipe(Effect.provide(protocol));
      const shown = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) ? Cause.pretty(exit.cause) : JSON.stringify(exit.value);
      const showsNone = (text: string) => {
        for (const value of VALUES) assert.notInclude(text, value);
      };

      const id = SecretId.make("sec_aaaaaaaaaaaaaaaa");
      const added = (totp: string) =>
        client["secrets.add"]({
          id,
          name: SecretName.make("example"),
          draft: {
            _tag: "login",
            origins: [SiteOrigin.make("https://example.com")],
            username: Redacted.make(USERNAME),
            password: Redacted.make(PASSWORD),
            totp: Redacted.make(totp),
          },
          access: { _tag: "every-bot" },
          request: null,
        });
      showsNone(shown(yield* Effect.exit(added("not-a-totp-value"))));
      showsNone(shown(yield* Effect.exit(added(TOTP))));
      showsNone(
        shown(
          yield* Effect.exit(
            client["secrets.add"]({
              id: SecretId.make("sec_bbbbbbbbbbbbbbbb"),
              name: SecretName.make("weather-api"),
              draft: { _tag: "value", value: Redacted.make(TOKEN) },
              access: { _tag: "every-bot" },
              request: null,
            }),
          ),
        ),
      );
      const revealed = yield* client["secrets.reveal"]({ id, field: "password" });
      assert.strictEqual(Redacted.value(revealed), PASSWORD);
      showsNone(
        shown(
          yield* Effect.exit(
            client["secrets.update"]({ id, changes: { password: Redacted.make(NEXT_PASSWORD) } }),
          ),
        ),
      );
      showsNone(shown(yield* Effect.exit(client["secrets.totpPreview"]({ id }))));
      showsNone(shown(yield* Effect.exit(client["secrets.list"]())));
      // Refused by the contract before the secrets see it.
      showsNone(
        shown(
          yield* Effect.exit(
            unchecked["secrets.openOldVault"]({ password: OLD_PASSWORD.repeat(60) }),
          ),
        ),
      );

      for (const line of logged) showsNone(line);
    }).pipe(Effect.scoped),
  );
});
