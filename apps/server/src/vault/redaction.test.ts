// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { CredentialId, HTTP_PATHS, Label, SiteOrigin, VaultRpcs } from "@j3-bots/contracts";
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

/** What a client could send as `vault.unlock`, unchecked: a password of any length. */
const UncheckedRpcs = RpcGroup.make(
  Rpc.make("vault.unlock", { payload: { password: Schema.String }, success: Schema.Unknown }),
);

const MASTER = "master-password-value";
const WRONG = "wrong-password-value";
const USERNAME = "username-value@example.com";
const PASSWORD = "login-password-value";
const TOTP = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const VALUES = [MASTER, WRONG, USERNAME, PASSWORD, TOTP, "not-a-totp-value"];

// The client listener as the server runs it, on a port the system chooses.
it.layer(
  Http.serve(Listener.layer, { logAddress: false }).pipe(
    Layer.provide(recordLogs),
    Layer.provide(WebClient.statusLayer),
    Layer.provide(TestUpdates.layer),
    Layer.provideMerge(TestDomain.servedLayer),
  ),
  { excludeTestServices: true },
)("the vault's values over the socket", (it) => {
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
      const client = yield* RpcClient.make(VaultRpcs).pipe(Effect.provide(protocol));
      const unchecked = yield* RpcClient.make(UncheckedRpcs).pipe(Effect.provide(protocol));
      const shown = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) ? Cause.pretty(exit.cause) : JSON.stringify(exit.value);
      const showsNone = (text: string) => {
        for (const value of VALUES) assert.notInclude(text, value);
      };

      yield* client["vault.setup"]({ password: Redacted.make(MASTER) });
      const id = CredentialId.make("cred_aaaaaaaaaaaaaaaa");
      const login = {
        name: Label.make("Example"),
        origins: [SiteOrigin.make("https://example.com")] as const,
        username: Redacted.make(USERNAME),
        password: Redacted.make(PASSWORD),
        allowedBots: [],
        request: null,
      };
      showsNone(
        shown(
          yield* Effect.exit(
            client["vault.save"]({ id, ...login, totp: Redacted.make("not-a-totp-value") }),
          ),
        ),
      );
      showsNone(
        shown(
          yield* Effect.exit(client["vault.save"]({ id, ...login, totp: Redacted.make(TOTP) })),
        ),
      );
      const revealed = yield* client["vault.reveal"]({ id, field: "password" });
      assert.strictEqual(Redacted.value(revealed), PASSWORD);
      showsNone(shown(yield* Effect.exit(client["vault.totpPreview"]({ id }))));
      showsNone(shown(yield* Effect.exit(client["vault.list"]())));

      yield* client["vault.lock"]();
      showsNone(
        shown(yield* Effect.exit(client["vault.unlock"]({ password: Redacted.make(WRONG) }))),
      );
      // Refused by the contract before the vault sees it.
      showsNone(
        shown(yield* Effect.exit(unchecked["vault.unlock"]({ password: MASTER.repeat(60) }))),
      );
      showsNone(
        shown(
          yield* Effect.exit(
            client["vault.changePassword"]({
              current: Redacted.make(WRONG),
              next: Redacted.make(MASTER),
            }),
          ),
        ),
      );

      for (const line of logged) showsNone(line);
    }).pipe(Effect.scoped),
  );
});
