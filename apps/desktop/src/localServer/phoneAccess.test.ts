// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PairingCode, ServerOrigin } from "@j3-bots/contracts";
import type { LocalServerState, PhoneAccess as Access } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerChoice from "../serverChoice.ts";
import * as Settings from "../settings.ts";
import { AdminRefused, type AdminChannel, type PairingOffer } from "./adminChannel.ts";
import * as PhoneAccess from "./phoneAccess.ts";
import * as Supervisor from "./supervisor.ts";

const LAN_ORIGIN = ServerOrigin.make("http://192.168.1.20:3747");
const LOOPBACK_ORIGIN = ServerOrigin.make("http://127.0.0.1:3747");
const CODE = PairingCode.make("7KQ2M9XH4D");
const EXPIRES = DateTime.makeUnsafe("2026-11-20T17:45:00Z");

/** What the fake servers do, as each test sets it. */
interface World {
  /** The first public address of the computer's interfaces, if any. */
  publicAddress: Option.Option<string>;
  /**
   * Whether a server started on the network stops before it answers, and
   * why: its port is taken there, or a public address appeared as it started.
   */
  lanFails: false | "port-taken" | "public-address";
  /** What `/running-work` answers. */
  work: AdminChannel["runningWork"];
  /** The `publicOrigin` the servers run with, if any. */
  publicOrigin: ServerOrigin | undefined;
  /** What each launch waits for before it reads where to listen. */
  beforeLaunch: Effect.Effect<void>;
  /** Whether each launch fails, for a reason waiting does not change. */
  launchRefused: boolean;
  /** What each reading of the interfaces waits for. */
  readingAddresses: Effect.Effect<void>;
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
  const fails = lan ? world.lanFails : false;
  if (fails === "public-address") world.publicAddress = Option.some("203.0.113.7");
  if (fails !== false) end({ code: Supervisor.START_REFUSED, signal: null });
  const { publicOrigin } = world;
  const admin: AdminChannel = {
    status: () =>
      fails !== false
        ? Effect.never
        : Effect.succeed({
            version: "0.3.0",
            pid,
            listener: { address: lan ? "0.0.0.0" : "127.0.0.1", port: 3747 },
            // As `reachableOrigins` lists them: the public origin first, then
            // the interfaces. Loopback is never offered to a phone.
            origins: [
              ...(publicOrigin === undefined ? [] : [publicOrigin]),
              LOOPBACK_ORIGIN,
              ...(lan ? [LAN_ORIGIN] : []),
            ],
            ...(publicOrigin === undefined ? {} : { publicOrigin }),
            engine: { state: { _tag: "ready" } },
          }),
    localDevice: () => Effect.die("not used here"),
    shutdown: Effect.sync(() => end({ code: 0, signal: null })),
    runningWork: Effect.suspend(() => world.work),
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
    logTail: Effect.succeed(fails === "port-taken" ? "Port 3747 is in use on 0.0.0.0." : ""),
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

/** The settings in `file`, whose `nth` write tells `reached`, then waits for `go`. */
const heldSettings = (
  file: string,
  nth: number,
  reached: Deferred.Deferred<void>,
  go: Deferred.Deferred<void>,
) =>
  Layer.effect(Settings.DesktopSettings)(
    Effect.gen(function* () {
      const settings = yield* Settings.DesktopSettings;
      let writes = 0;
      return {
        get: settings.get,
        update: (change: (now: Settings.Settings) => Settings.Settings) =>
          Effect.suspend(() => {
            writes += 1;
            if (writes !== nth) return settings.update(change);
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(go)),
              Effect.andThen(settings.update(change)),
            );
          }),
      };
    }),
  ).pipe(Layer.provide(Settings.layer(file)));

/** A page that does nothing, as choosing where the bots live acts on it. */
const page: ServerChoice.Page = { clearStorage: Effect.void, openHome: Effect.void };

/**
 * The supervisor of a server on this computer, the choice of where the bots
 * live, and phone access to the server, as the app wires them, in a `world`
 * of fake servers.
 */
const setUp = (world: World, leftRunning: Option.Option<PhoneAccess.ListenHost> = Option.none()) =>
  Effect.gen(function* () {
    const listening = yield* PhoneAccess.listening({
      publicAddress: Effect.suspend(() => world.readingAddresses).pipe(
        Effect.andThen(Effect.sync(() => world.publicAddress)),
      ),
    });
    let pid = 100;
    const supervisor = yield* Supervisor.make({
      launch: Effect.gen(function* () {
        yield* world.beforeLaunch;
        if (world.launchRefused) {
          return yield* new Supervisor.LaunchFailed({ reason: "No runtime.", retry: false });
        }
        const host = yield* listening.hostForLaunch;
        world.hosts.push(host);
        pid += 1;
        return fakeServer(pid, host, world);
      }),
      // A server an earlier run of the app left running, on that host.
      adopt: Effect.sync(() => Option.map(leftRunning, (host) => fakeServer(99, host, world))),
    });
    const choice = yield* ServerChoice.make(() => Effect.succeed(null), {
      available: true,
      prepare: Effect.succeed(LOOPBACK_ORIGIN),
      start: supervisor.start,
      stop: supervisor.stop,
      exportTo: () => Effect.die("phone access never exports"),
      deleteData: Effect.die("phone access never deletes the data"),
    });
    const phone = yield* PhoneAccess.serve({
      listening,
      supervisor,
      whileLocal: choice.whileLocal,
    });
    return { supervisor, choice, phone };
  });

const newWorld = (changes: Partial<World> = {}): World => ({
  publicAddress: Option.none(),
  lanFails: false,
  work: Effect.succeed(0),
  publicOrigin: undefined,
  beforeLaunch: Effect.void,
  launchRefused: false,
  readingAddresses: Effect.void,
  offer: { _tag: "granted", code: CODE, expiresAt: EXPIRES },
  hosts: [],
  pairings: [],
  ...changes,
});

const LOCAL = { mode: "local", server: LOOPBACK_ORIGIN };

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
      const world = newWorld({ work: Effect.succeed(2) });
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
        const world = newWorld({ lanFails: "port-taken" });
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
    "gives a phone a link to a private address of its own only, and lifts a lock only when asked",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        // A way in the operator set up for elsewhere is not one a phone here is sent to.
        const world = newWorld({ publicOrigin: ServerOrigin.make("https://j3.example.test") });
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

  it.effect(
    "ends on this computer alone when turned off while a start on the network reads the choice",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        const offWrite = yield* Deferred.make<void>();
        const writeOff = yield* Deferred.make<void>();
        const world = newWorld();
        // The second write is turning it off.
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(heldSettings(file, 2, offWrite, writeOff)),
        );
        yield* supervisor.start;
        yield* serverReady(supervisor, world, 1);

        const launch = yield* Deferred.make<void>();
        world.beforeLaunch = Deferred.await(launch);
        yield* phone.set({ on: true, stopWork: false });
        const off = yield* Effect.forkChild(phone.set({ on: false, stopWork: false }));
        yield* Deferred.await(offWrite);
        // The start under way reads the choice before off is kept.
        yield* Deferred.succeed(launch, undefined);
        yield* serverReady(supervisor, world, 2);
        yield* Deferred.succeed(writeOff, undefined);
        assert.strictEqual((yield* Fiber.join(off))._tag, "changed");

        yield* serverReady(supervisor, world, 3);
        assert.deepStrictEqual(world.hosts, ["127.0.0.1", "lan", "127.0.0.1"]);
        assert.deepStrictEqual(yield* phone.current, { on: false, origins: [] });
        assert.isFalse((yield* kept(file)).phoneAccess);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "starts a server that answers on the network again on this computer alone, once turned off while it started",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        const world = newWorld();
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        yield* serverReady(supervisor, world, 1);

        const launch = yield* Deferred.make<void>();
        world.beforeLaunch = Deferred.await(launch);
        yield* phone.set({ on: true, stopWork: false });
        // The start under way reads the choice, on, then the interfaces, and waits there.
        const reading = yield* Deferred.make<void>();
        const addresses = yield* Deferred.make<void>();
        world.readingAddresses = Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(addresses)),
        );
        yield* Deferred.succeed(launch, undefined);
        yield* Deferred.await(reading);
        // Off is kept while it waits, and finds the server where it last answered.
        assert.deepStrictEqual(yield* phone.set({ on: false, stopWork: false }), {
          _tag: "changed",
          access: { on: false, origins: [] },
        });
        world.readingAddresses = Effect.void;
        yield* Deferred.succeed(addresses, undefined);

        yield* serverReady(supervisor, world, 3);
        assert.deepStrictEqual(world.hosts, ["127.0.0.1", "lan", "127.0.0.1"]);
        assert.isFalse((yield* kept(file)).phoneAccess);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("asks before a restart while the server cannot say whether bots are working", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(LOCAL);
      const world = newWorld({
        work: Effect.fail(new AdminRefused({ route: "/running-work", status: 500 })),
      });
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      yield* serverReady(supervisor, world, 1);

      assert.deepStrictEqual(yield* phone.set({ on: true, stopWork: false }), {
        _tag: "work-running",
        bots: null,
      });
      assert.deepStrictEqual(world.hosts, ["127.0.0.1"]);
      assert.isFalse((yield* kept(file)).phoneAccess);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("asks again right before the restart, as work may have started since", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(LOCAL);
      let asked = 0;
      const world = newWorld({ work: Effect.sync(() => (asked++ === 0 ? 0 : 1)) });
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      yield* serverReady(supervisor, world, 1);

      assert.deepStrictEqual(yield* phone.set({ on: true, stopWork: false }), {
        _tag: "work-running",
        bots: 1,
      });
      // The server kept running where it was.
      assert.deepStrictEqual(world.hosts, ["127.0.0.1"]);
      assert.strictEqual((yield* supervisor.state).state, "ready");
      assert.isFalse((yield* kept(file)).phoneAccess);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps nothing once the bots stop running here while it asked the server, so they come back on this computer alone",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile(LOCAL);
        const asking = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const world = newWorld({
          work: Deferred.succeed(asking, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
            Effect.as(0),
          ),
        });
        const { supervisor, choice, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        yield* serverReady(supervisor, world, 1);

        const turningOn = yield* Effect.forkChild(phone.set({ on: true, stopWork: false }));
        yield* Deferred.await(asking);
        assert.strictEqual(yield* choice.connectToServerInstead(page), "changed");
        yield* Deferred.succeed(answer, undefined);
        assert.strictEqual((yield* Fiber.join(turningOn))._tag, "not-saved");
        assert.isFalse((yield* kept(file)).phoneAccess);

        world.work = Effect.succeed(0);
        assert.strictEqual(yield* choice.useThisComputer(page), "changed");
        yield* serverReady(supervisor, world, 2);
        assert.deepStrictEqual(world.hosts, ["127.0.0.1", "127.0.0.1"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "says a public address that appeared as the server started is why it stays on this computer",
    () =>
      Effect.gen(function* () {
        const file = yield* settingsFile({ ...LOCAL, phoneAccess: true });
        const world = newWorld({ lanFails: "public-address" });
        const { supervisor, phone } = yield* setUp(world).pipe(
          Effect.provide(Settings.layer(file)),
        );
        yield* supervisor.start;
        assert.deepStrictEqual(
          yield* reach(phone.changes, (access) => access.refusedReason !== undefined),
          { on: true, origins: [], refusedReason: "public-address" },
        );
        yield* serverReady(supervisor, world, 2);
        assert.deepStrictEqual(world.hosts, ["lan", "127.0.0.1"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves a server an earlier run left on the network only once no bot works there", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile(LOCAL);
      const asked = yield* Deferred.make<void>();
      const world = newWorld({
        work: Deferred.succeed(asked, undefined).pipe(Effect.as(1)),
      });
      const { supervisor, phone } = yield* setUp(world, Option.some("lan")).pipe(
        Effect.provide(Settings.layer(file)),
      );
      yield* supervisor.start;
      // Phone access is off, but a bot works there: it stays where it is.
      yield* Deferred.await(asked);
      assert.deepStrictEqual(world.hosts, []);
      assert.strictEqual((yield* supervisor.state).state, "ready");

      world.work = Effect.succeed(0);
      yield* TestClock.adjust(PhoneAccess.WORK_POLL);
      yield* serverReady(supervisor, world, 1);
      assert.deepStrictEqual(world.hosts, ["127.0.0.1"]);
      assert.deepStrictEqual(yield* phone.current, { on: false, origins: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says the bots stopped, not that it is turning on, while the server failed", () =>
    Effect.gen(function* () {
      const file = yield* settingsFile({ ...LOCAL, phoneAccess: true });
      const world = newWorld({ launchRefused: true });
      const { supervisor, phone } = yield* setUp(world).pipe(Effect.provide(Settings.layer(file)));
      yield* supervisor.start;
      assert.deepStrictEqual(
        yield* reach(phone.changes, (access) => access.refusedReason !== undefined),
        { on: true, origins: [], refusedReason: "not-running" },
      );

      // Tried again once repaired, it reaches the network.
      world.launchRefused = false;
      yield* supervisor.retry;
      assert.deepStrictEqual(yield* reach(phone.changes, held), {
        on: true,
        origins: [LAN_ORIGIN],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
