// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PairingCode, ServerOrigin } from "@j3-bots/contracts";
import type { LocalServerState, PhoneAccess as Access } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Settings from "../settings.ts";
import type { AdminChannel, PairingOffer } from "./adminChannel.ts";
import * as PhoneAccess from "./phoneAccess.ts";
import * as Supervisor from "./supervisor.ts";

const LAN_ORIGIN = ServerOrigin.make("http://192.168.1.20:3747");
const CODE = PairingCode.make("7KQ2M9XH4D");
const EXPIRES = DateTime.makeUnsafe("2026-11-20T17:45:00Z");

/** What the fake servers do, as each test sets it. */
interface World {
  /** The first public address of the computer's interfaces, if any. */
  publicAddress: Option.Option<string>;
  /** Whether a server started on the network stops before it answers, as when its port is taken there. */
  lanFails: boolean;
  /** How many bots have work running. */
  bots: number;
  /** What `/pairing` answers. */
  offer: PairingOffer;
  /** Where each start listened, in order. */
  readonly hosts: Array<PhoneAccess.ListenHost>;
  /** Each `/pairing` asked, with whether it unlocked first. */
  readonly pairings: Array<boolean>;
}

/** A server started on `host`: it answers its admin channel as the real one does, until it is stopped. */
const fakeServer = (pid: number, host: PhoneAccess.ListenHost, world: World) => {
  const exited = Deferred.makeUnsafe<Supervisor.ServerExit>();
  const end = (exit: Supervisor.ServerExit) => Deferred.doneUnsafe(exited, Effect.succeed(exit));
  const lan = host === "lan";
  if (lan && world.lanFails) end({ code: Supervisor.START_REFUSED, signal: null });
  const admin: AdminChannel = {
    status: () =>
      lan && world.lanFails
        ? Effect.never
        : Effect.succeed({
            version: "0.3.0",
            pid,
            listener: { address: lan ? "0.0.0.0" : "127.0.0.1", port: 3747 },
            // As `reachableOrigins` lists them; loopback is never offered to a phone.
            origins: lan
              ? [ServerOrigin.make("http://127.0.0.1:3747"), LAN_ORIGIN]
              : [ServerOrigin.make("http://127.0.0.1:3747")],
            engine: { state: { _tag: "ready" } },
          }),
    localDevice: () => Effect.die("not used here"),
    shutdown: Effect.sync(() => end({ code: 0, signal: null })),
    runningWork: Effect.sync(() => world.bots),
    pairing: (unlock) =>
      Effect.sync(() => {
        world.pairings.push(unlock);
        return world.offer;
      }),
  };
  return {
    pid,
    admin,
    exited: Deferred.await(exited),
    logTail: Effect.succeed(lan && world.lanFails ? "Port 3747 is in use on 0.0.0.0." : ""),
    terminate: Effect.sync(() => {
      end({ code: 0, signal: "SIGTERM" });
      return true;
    }),
    kill: Effect.sync(() => end({ code: null, signal: "SIGKILL" })),
  } satisfies Supervisor.RunningServer;
};

/** A settings file holding `settings`, in a fresh folder. */
const settingsFile = (settings: object) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-phone-" }),
      "desktop.json",
    );
    yield* fs.writeFileString(file, JSON.stringify(settings));
    return file;
  });

/**
 * The supervisor of a server on this computer and phone access to it, as
 * the app wires them, over the settings in `file`, in a `world` of fake servers.
 */
const setUp = (world: World) =>
  Effect.gen(function* () {
    const listening = yield* PhoneAccess.listening({
      publicAddress: Effect.sync(() => world.publicAddress),
    });
    let pid = 100;
    const supervisor = yield* Supervisor.make({
      launch: Effect.gen(function* () {
        const host = yield* listening.hostForLaunch;
        world.hosts.push(host);
        pid += 1;
        return fakeServer(pid, host, world);
      }),
      adopt: Effect.succeedNone,
    });
    const phone = yield* PhoneAccess.serve({
      listening,
      supervisor,
      restart: Effect.andThen(supervisor.stop, supervisor.start),
    });
    return { supervisor, phone };
  });

const newWorld = (changes: Partial<World> = {}): World => ({
  publicAddress: Option.none(),
  lanFails: false,
  bots: 0,
  offer: { _tag: "granted", code: CODE, expiresAt: EXPIRES },
  hosts: [],
  pairings: [],
  ...changes,
});

const LOCAL = { mode: "local", server: "http://127.0.0.1:3747" };

/** Waits for phone access to hold `matches`. */
const reach = (changes: Stream.Stream<Access>, matches: (access: Access) => boolean) =>
  changes.pipe(Stream.filter(matches), Stream.runHead, Effect.map(Option.getOrThrow));

/** Waits for the server to answer, once it has started `starts` times. */
const serverReady = (supervisor: Supervisor.Supervisor, world: World, starts: number) =>
  supervisor.changes.pipe(
    Stream.filter(
      (state: LocalServerState) => state.state === "ready" && world.hosts.length === starts,
    ),
    Stream.runHead,
  );

const held = (access: Access) => access.origins.length > 0;

/** What the settings file holds now, as the next launch of the app reads it. */
const kept = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return Settings.decodeSettings(yield* fs.readFileString(file)).settings;
  });

describe("phone access to the server on this computer", () => {
  it.effect(
    "is off at first, then restarts the server on the network, shows its private addresses, and keeps the choice",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        const world = newWorld();
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        yield* serverReady(supervisor, world, 1);
        assert.deepStrictEqual(yield* phone.current, { on: false, origins: [] });

        const turnedOn = yield* phone.set({ on: true, stopWork: false });
        // The server moves: nothing to show until it answers on the network.
        assert.deepStrictEqual(turnedOn, { _tag: "changed", access: { on: true, origins: [] } });
        assert.deepStrictEqual(yield* reach(phone.changes, held), {
          on: true,
          origins: [LAN_ORIGIN],
        });
        assert.deepStrictEqual(world.hosts, ["127.0.0.1", "lan"]);
        assert.isTrue((yield* kept(file)).phoneAccess);

        // Off: back on this computer alone.
        const turnedOff = yield* phone.set({ on: false, stopWork: false });
        assert.deepStrictEqual(turnedOff, { _tag: "changed", access: { on: false, origins: [] } });
        yield* reach(phone.changes, (access) => !access.on);
        yield* serverReady(supervisor, world, 3);
        assert.deepStrictEqual(world.hosts, ["127.0.0.1", "lan", "127.0.0.1"]);
        assert.isFalse((yield* kept(file)).phoneAccess);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts the server on the network when the app starts with it left on", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile({ ...LOCAL, phoneAccess: true });
      const world = newWorld();
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      assert.deepStrictEqual(yield* reach(phone.changes, held), {
        on: true,
        origins: [LAN_ORIGIN],
      });
      assert.deepStrictEqual(world.hosts, ["lan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("asks before a restart that would stop work the bots have running", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(LOCAL);
      const world = newWorld({ bots: 2 });
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      yield* serverReady(supervisor, world, 1);

      assert.deepStrictEqual(yield* phone.set({ on: true, stopWork: false }), {
        _tag: "work-running",
        bots: 2,
      });
      assert.deepStrictEqual(world.hosts, ["127.0.0.1"]);
      assert.isFalse((yield* kept(file)).phoneAccess);

      // Once the operator agreed.
      yield* phone.set({ on: true, stopWork: true });
      yield* reach(phone.changes, held);
      assert.deepStrictEqual(world.hosts, ["127.0.0.1", "lan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays on this computer alone on a network that gives it a public address", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(LOCAL);
      const world = newWorld({ publicAddress: Option.some("203.0.113.7") });
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      yield* serverReady(supervisor, world, 1);

      // Nothing moves, so nothing stops: it says why at once.
      assert.deepStrictEqual(yield* phone.set({ on: true, stopWork: false }), {
        _tag: "changed",
        access: { on: true, origins: [], refusedReason: "public-address" },
      });
      assert.deepStrictEqual(world.hosts, ["127.0.0.1"]);

      // Started again on the same network, as at the next launch, it still stays.
      yield* supervisor.stop;
      yield* supervisor.start;
      yield* serverReady(supervisor, world, 2);
      assert.deepStrictEqual(world.hosts, ["127.0.0.1", "127.0.0.1"]);
      assert.deepStrictEqual(yield* phone.current, {
        on: true,
        origins: [],
        refusedReason: "public-address",
      });

      // On a private network, asking again moves it.
      world.publicAddress = Option.none();
      yield* phone.set({ on: true, stopWork: false });
      yield* reach(phone.changes, held);
      assert.deepStrictEqual(world.hosts, ["127.0.0.1", "127.0.0.1", "lan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "falls back to this computer alone when the server does not start on the network, and tries again when asked",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile({ ...LOCAL, phoneAccess: true });
        const world = newWorld({ lanFails: true });
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        assert.deepStrictEqual(
          yield* reach(phone.changes, (access) => access.refusedReason !== undefined),
          {
            on: true,
            origins: [],
            refusedReason: "unavailable",
            detail: "Port 3747 is in use on 0.0.0.0.",
          },
        );
        // The app is never left without its server.
        yield* serverReady(supervisor, world, 2);
        assert.deepStrictEqual(world.hosts, ["lan", "127.0.0.1"]);
        // The choice stays the operator's.
        assert.isTrue((yield* kept(file)).phoneAccess);

        world.lanFails = false;
        yield* phone.set({ on: true, stopWork: false });
        yield* reach(phone.changes, held);
        assert.deepStrictEqual(world.hosts, ["lan", "127.0.0.1", "lan"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "gives a phone a link to a private address only, and lifts a lock only when asked",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        const world = newWorld();
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        yield* serverReady(supervisor, world, 1);
        // On 127.0.0.1 no phone can follow a link.
        assert.deepStrictEqual(yield* phone.pairingLink(false), { _tag: "phone-access-off" });
        assert.deepStrictEqual(world.pairings, []);

        yield* phone.set({ on: true, stopWork: false });
        yield* reach(phone.changes, held);
        assert.deepStrictEqual(yield* phone.pairingLink(false), {
          _tag: "granted",
          code: CODE,
          expiresAt: EXPIRES,
          origins: [LAN_ORIGIN],
        });

        const until = DateTime.makeUnsafe("2026-11-20T17:55:00Z");
        world.offer = { _tag: "locked", until };
        assert.deepStrictEqual(yield* phone.pairingLink(false), { _tag: "locked", until });
        yield* phone.pairingLink(true);
        assert.deepStrictEqual(world.pairings, [false, false, true]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
