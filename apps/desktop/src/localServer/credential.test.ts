// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DeviceId, DeviceToken, MAX_LABEL_LENGTH } from "@j3-bots/contracts";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Settings from "../settings.ts";
import type { AdminChannel, LocalDeviceRequest } from "./adminChannel.ts";
import { AdminRefused } from "./adminChannel.ts";
import * as Credential from "./credential.ts";
import * as Supervisor from "./supervisor.ts";

const LOCAL = Schema.decodeSync(ServerOrigin)("http://127.0.0.1:3747");
const OLD_DEVICE = Schema.decodeSync(DeviceId)("device-old");
const NEW_DEVICE = Schema.decodeSync(DeviceId)("device-new");
const TOKEN = Schema.decodeSync(DeviceToken)("t".repeat(43));
const PID = 4242;

/**
 * A server whose status answers `statusPid` and the port it `listensOn`
 * (the kept one unless told), and that mints NEW_DEVICE unless it `refuses`.
 */
const server = (
  options: {
    readonly statusPid?: number;
    readonly listensOn?: number;
    readonly refuses?: boolean;
  } = {},
) => {
  const asked: Array<LocalDeviceRequest> = [];
  const admin: AdminChannel = {
    status: () =>
      Effect.succeed({
        version: "0.3.0",
        pid: options.statusPid ?? PID,
        listener: { port: options.listensOn ?? 3747 },
        engine: { state: { _tag: "ready" } },
      }),
    localDevice: (request) =>
      Effect.suspend(() => {
        asked.push(request);
        return options.refuses === true
          ? Effect.fail(new AdminRefused({ route: "/local-device", status: 400 }))
          : Effect.succeed({ deviceId: NEW_DEVICE, token: TOKEN });
      }),
    shutdown: Effect.void,
  };
  const running: Supervisor.RunningServer = {
    pid: PID,
    admin,
    exited: Effect.never,
    logTail: Effect.succeed(""),
    terminate: Effect.succeed(true),
    kill: Effect.void,
  };
  return { running, asked };
};

/** A sign-in whose supervisor answers `ready`, over the settings `stored`. */
const signingIn = (
  stored: unknown,
  ready: Effect.Effect<Supervisor.RunningServer, Supervisor.NotReady>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-credential-" });
    const file = path.join(directory, "desktop.json");
    yield* fs.writeFileString(file, JSON.stringify(stored));
    return yield* Effect.gen(function* () {
      const settings = yield* Settings.DesktopSettings;
      const signIn = yield* Credential.make({ supervisor: { ready }, name: "workstation" });
      return { signIn, settings };
    }).pipe(Effect.provide(Settings.layer(file)));
  });

const local = (localDevice: { readonly id: string; readonly current: boolean } | null) => ({
  mode: "local",
  server: LOCAL,
  localDevice,
  window: null,
});

describe("signing this computer in to the server it runs", () => {
  it.effect("mints a device, hands its token over, and keeps only its id", () =>
    Effect.gen(function* () {
      const fake = server();
      const { signIn, settings } = yield* signingIn(local(null), Effect.succeed(fake.running));
      const result = yield* signIn({ again: false });
      assert.deepStrictEqual(result, {
        _tag: "minted",
        server: LOCAL,
        deviceId: NEW_DEVICE,
        token: TOKEN,
      });
      assert.deepStrictEqual(fake.asked, [{ name: "workstation", replaces: null }]);
      assert.deepStrictEqual((yield* settings.get).localDevice, { id: NEW_DEVICE, current: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "replaces the device it signed in before, after the operator chose this computer again",
    () =>
      Effect.gen(function* () {
        const fake = server();
        const { signIn } = yield* signingIn(
          local({ id: OLD_DEVICE, current: false }),
          Effect.succeed(fake.running),
        );
        yield* signIn({ again: false });
        assert.deepStrictEqual(fake.asked, [{ name: "workstation", replaces: OLD_DEVICE }]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not sign in again by itself once its device was revoked", () =>
    Effect.gen(function* () {
      const fake = server();
      const { signIn, settings } = yield* signingIn(
        local({ id: OLD_DEVICE, current: true }),
        Effect.succeed(fake.running),
      );
      const result = yield* signIn({ again: false });
      assert.deepStrictEqual(result, { _tag: "signed-out" });
      assert.deepStrictEqual(fake.asked, []);
      assert.deepStrictEqual((yield* settings.get).localDevice, { id: OLD_DEVICE, current: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("signs in again when the operator asks, replacing the revoked device", () =>
    Effect.gen(function* () {
      const fake = server();
      const { signIn, settings } = yield* signingIn(
        local({ id: OLD_DEVICE, current: true }),
        Effect.succeed(fake.running),
      );
      const result = yield* signIn({ again: true });
      assert.strictEqual(result._tag, "minted");
      assert.deepStrictEqual(fake.asked, [{ name: "workstation", replaces: OLD_DEVICE }]);
      assert.deepStrictEqual((yield* settings.get).localDevice, { id: NEW_DEVICE, current: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("mints nothing on a server whose admin channel answers for another process", () =>
    Effect.gen(function* () {
      const fake = server({ statusPid: PID + 1 });
      const { signIn, settings } = yield* signingIn(local(null), Effect.succeed(fake.running));
      const result = yield* signIn({ again: false });
      assert.deepStrictEqual(result, { _tag: "failed" });
      assert.deepStrictEqual(fake.asked, []);
      assert.isNull((yield* settings.get).localDevice);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("mints nothing for an address the server does not listen on", () =>
    Effect.gen(function* () {
      // The settings keep the page on 3747; the server says it listens on 3790.
      const fake = server({ listensOn: 3790 });
      const { signIn, settings } = yield* signingIn(
        local({ id: OLD_DEVICE, current: false }),
        Effect.succeed(fake.running),
      );
      const result = yield* signIn({ again: false });
      assert.deepStrictEqual(result, { _tag: "failed" });
      assert.deepStrictEqual(fake.asked, []);
      const after = yield* settings.get;
      assert.strictEqual(after.server, LOCAL);
      assert.deepStrictEqual(after.localDevice, { id: OLD_DEVICE, current: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the device it had when the server refuses to mint one", () =>
    Effect.gen(function* () {
      const fake = server({ refuses: true });
      const { signIn, settings } = yield* signingIn(
        local({ id: OLD_DEVICE, current: false }),
        Effect.succeed(fake.running),
      );
      assert.deepStrictEqual(yield* signIn({ again: false }), { _tag: "failed" });
      assert.deepStrictEqual((yield* settings.get).localDevice, { id: OLD_DEVICE, current: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers that no server runs on this computer in remote mode", () =>
    Effect.gen(function* () {
      const fake = server();
      const { signIn } = yield* signingIn(
        { mode: "remote", server: LOCAL, window: null },
        Effect.succeed(fake.running),
      );
      assert.deepStrictEqual(yield* signIn({ again: true }), { _tag: "not-running" });
      assert.deepStrictEqual(fake.asked, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers that no server runs when the server failed to start", () =>
    Effect.gen(function* () {
      const { signIn } = yield* signingIn(
        local(null),
        Effect.fail(new Supervisor.NotReady({ state: "failed" })),
      );
      assert.deepStrictEqual(yield* signIn({ again: false }), { _tag: "not-running" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the name this computer signs in as", () => {
  it("is its own name, cut to a label's length, or a plain one for a blank name", () => {
    assert.strictEqual(Credential.deviceName("  workstation "), "workstation");
    assert.strictEqual(Credential.deviceName("   "), "This computer");
    assert.strictEqual(Credential.deviceName("x".repeat(500)).length, MAX_LABEL_LENGTH);
  });
});
