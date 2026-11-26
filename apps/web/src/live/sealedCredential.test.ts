// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  alwaysForeground,
  Cell,
  ClientStorage,
  CredentialStorageError,
  CredentialStore,
  DeviceTimeZone,
  createJ3Client,
  type DeviceCredential,
  FileTransfer,
  type LocalTable,
  makeInProcessLocks,
  Network,
  type Readable,
  ServerAddress,
  TransferFailed,
  WindowLocks,
} from "@j3-bots/client-runtime";
import { BotId, DeviceId, DeviceToken, type EntryTarget } from "@j3-bots/contracts";
import type { OpenResult, TokenProtection } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { type CredentialCell, makeCredentialStore } from "./credentialStore";
import { SEALER_DEADLINE, sealedCredential, type TokenSealer } from "./sealedCredential";

const serverA = new URL("http://192.168.1.20:3737");
const serverB = new URL("https://bots.example.com");

const credentialOf = (device: string, letter: string): DeviceCredential => ({
  deviceId: DeviceId.make(device),
  token: Redacted.make(DeviceToken.make(letter.repeat(32))),
});
const first = credentialOf("device-1", "a");
const second = credentialOf("device-2", "b");

const plain = (found: Option.Option<DeviceCredential>) =>
  Option.map(found, ({ deviceId, token }) => ({ deviceId, token: Redacted.value(token) }));

/** IndexedDB's one credential record, in memory. */
const memoryCell = () => {
  let value: unknown;
  const cell: CredentialCell = {
    get: () => Promise.resolve(value),
    put: (next) => {
      value = next;
      return Promise.resolve();
    },
    replace: (expected, next) => {
      if (value !== expected) return Promise.resolve(false);
      value = next ?? undefined;
      return Promise.resolve(true);
    },
  };
  return { cell, stored: () => value };
};

/**
 * The system that seals the token for the app. While `locked`, it opens
 * nothing, as a locked keyring.
 */
const makeSystem = () => {
  const sealedTokens = new Map<string, string>();
  const system = { protection: "encrypted" as TokenProtection, locked: false };
  const sealer: TokenSealer = {
    sealToken: (token) => {
      const sealed = btoa(`sealed-${sealedTokens.size}`);
      sealedTokens.set(sealed, token);
      return Promise.resolve({ sealed, protection: system.protection });
    },
    openToken: (sealed) => {
      const token = sealedTokens.get(sealed);
      const opened: OpenResult = system.locked
        ? { _tag: "unavailable" }
        : token === undefined
          ? { _tag: "failed" }
          : { _tag: "opened", token };
      return Promise.resolve(opened);
    },
  };
  return { system, sealer };
};

/** A bridge that is asked, and never answers. */
const silentSealer = () => {
  const asked = new Cell(0);
  const sealer: TokenSealer = {
    sealToken: () => new Promise(() => undefined),
    openToken: () => {
      asked.update((count) => count + 1);
      return new Promise(() => undefined);
    },
  };
  return { sealer, asked };
};

const storeFor = (server: URL, sealer: TokenSealer, cell: CredentialCell) =>
  makeCredentialStore({
    codec: sealedCredential(server, sealer),
    cell,
    announce: Effect.void,
    changes: Stream.empty,
  });

/** How `effect` ended, once `SEALER_DEADLINE` has passed on a test clock. */
const pastTheDeadline = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(Effect.exit(effect));
      yield* TestClock.adjust(SEALER_DEADLINE);
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestClock.layer())),
  );

const isStorageError = Schema.is(CredentialStorageError);

const failedWith = (exit: Exit.Exit<unknown, unknown>, operation: string) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      isStorageError(reason.error) &&
      reason.error.operation === operation,
  );

/** The device's drafts and unsent messages, in memory, guarded by the pairing `pairing` reads. */
const memoryStorage = (pairing: () => Option.Option<DeviceId>) => {
  const tables = new Map<LocalTable, Map<string, string>>([
    ["drafts", new Map()],
    ["outbox", new Map()],
  ]);
  const table = (name: LocalTable) => tables.get(name) ?? new Map<string, string>();
  /** Counts the writes, so a test can wait for one. */
  const writes = new Cell(0);
  const wrote = () => writes.update((count) => count + 1);
  const storage = ClientStorage.of({
    readAll: (name) =>
      Effect.sync(
        () => new Map([...table(name)].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ),
    write: (name, key, value) =>
      Effect.sync(() => {
        table(name).set(key, value);
        wrote();
      }),
    remove: (name, key) => Effect.sync(() => void table(name).delete(key)),
    clear: (name) => Effect.sync(() => table(name).clear()),
    commit: (changes, expected = [], owner) =>
      Effect.sync(() => {
        const holds =
          (owner === undefined || Option.contains(pairing(), owner)) &&
          expected.every(({ table: name, key, value }) => (table(name).get(key) ?? null) === value);
        if (!holds) return false;
        for (const { table: name, key, value } of changes) {
          if (value === null) table(name).delete(key);
          else table(name).set(key, value);
        }
        wrote();
        return true;
      }),
    changes: Stream.never,
  });
  return {
    storage,
    writes,
    sizes: () => [table("drafts").size, table("outbox").size],
  };
};

type Device = ReturnType<typeof memoryStorage>;

/** Resolves once `readable` holds a value that passes `test`. */
const when = <A>(readable: Readable<A>, test: (value: A) => boolean) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (!test(readable.get())) return;
      stop();
      resolve();
    };
    const stop = readable.subscribe(check);
    check();
  });

/**
 * A client of `serverA` with the credential in `cell`, read through
 * `sealer`, and the records in `device`. Offline: it never reaches for a
 * server. `clock`, when given, is its clock.
 */
const launch = (
  sealer: TokenSealer,
  cell: CredentialCell,
  device: Device,
  clock: Layer.Layer<never> = Layer.empty,
) =>
  createJ3Client(
    Layer.mergeAll(
      Layer.succeed(ServerAddress, { origin: serverA }),
      Layer.succeed(CredentialStore, storeFor(serverA, sealer, cell)),
      Layer.succeed(ClientStorage, device.storage),
      Layer.succeed(WindowLocks, makeInProcessLocks()),
      Layer.succeed(DeviceTimeZone, { current: Effect.succeed(null) }),
      Layer.succeed(
        FileTransfer,
        FileTransfer.of({ upload: () => Effect.fail(new TransferFailed()) }),
      ),
      Layer.succeed(
        Network,
        Network.of({ status: Effect.succeed("offline"), changes: Stream.never }),
      ),
      alwaysForeground,
      FetchHttpClient.layer,
      Socket.layerWebSocketConstructorGlobal,
      SecureRandom.layerWebCrypto,
      clock,
    ),
  );

const target: EntryTarget = { _tag: "conversation", botId: BotId.make("bot-1") };

/**
 * Pairs the device with `first`, sealed by `sealer`, and keeps a draft and
 * an unsent message for that pairing, as a window that then closed.
 */
const pairedWithRecords = async (sealer: TokenSealer) => {
  const { cell, stored } = memoryCell();
  const device = memoryStorage(() => sealedCredential(serverA, sealer).pairingOf(stored()));
  await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));
  const earlier = await launch(sealer, cell, device);
  await when(earlier.pairing, (pairing) => pairing === first.deviceId);
  earlier.setDraftText(target, "keep me");
  void earlier.send({ target, text: "on its way" });
  await when(device.writes, () => device.sizes().every((size) => size > 0));
  await earlier.dispose();
  return { cell, stored, device, kept: device.sizes() };
};

describe("the desktop app's credential", () => {
  it("is stored with its token sealed, and reads back", async () => {
    const { cell, stored } = memoryCell();
    const store = storeFor(serverA, makeSystem().sealer, cell);
    await Effect.runPromise(store.save(first));
    expect(String(stored())).not.toContain(Redacted.value(first.token));
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
  });

  it("is cleared only while it is still the one stored", async () => {
    const { cell } = memoryCell();
    const store = storeFor(serverA, makeSystem().sealer, cell);
    await Effect.runPromise(store.save(first));
    // Another window paired the device again since this one read `second`.
    expect(plain(await Effect.runPromise(store.clear(second, "here")))).toEqual(
      plain(Option.some(first)),
    );
    expect(await Effect.runPromise(store.clear(first, "here"))).toEqual(Option.none());
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
  });

  it("is cleared while the system will not open it", async () => {
    const { cell, stored } = memoryCell();
    const { system, sealer } = makeSystem();
    await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));
    system.locked = true;
    expect(await Effect.runPromise(storeFor(serverA, sealer, cell).clear(first, "here"))).toEqual(
      Option.none(),
    );
    expect(stored()).toBeUndefined();
  });

  it("leaves the server's refusal in its place, until the device is paired again", async () => {
    const { cell, stored } = memoryCell();
    const { sealer } = makeSystem();
    const store = storeFor(serverA, sealer, cell);
    await Effect.runPromise(store.save(first));
    expect(await Effect.runPromise(store.clear(first, "refused"))).toEqual(Option.none());
    expect(await Effect.runPromise(store.refusedPairing)).toEqual(Option.some(first.deviceId));
    // No write guarded by the pairing that ended takes it for a credential.
    expect(sealedCredential(serverA, sealer).pairingOf(stored())).toEqual(Option.none());

    await Effect.runPromise(store.save(second));
    expect(await Effect.runPromise(store.refusedPairing)).toEqual(Option.none());
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(second)));
  });

  it("reads as not paired when its token is not one the app sealed", async () => {
    const { cell } = memoryCell();
    await Effect.runPromise(storeFor(serverA, makeSystem().sealer, cell).save(first));
    // Sealed by another profile, or written by something else.
    expect(await Effect.runPromise(storeFor(serverA, makeSystem().sealer, cell).load)).toEqual(
      Option.none(),
    );
  });

  it("fails to load, and to save, when the app never answers", async () => {
    const { cell } = memoryCell();
    await Effect.runPromise(storeFor(serverA, makeSystem().sealer, cell).save(first));
    const store = storeFor(serverA, silentSealer().sealer, cell);
    expect(failedWith(await pastTheDeadline(store.load), "load")).toBe(true);
    expect(failedWith(await pastTheDeadline(store.save(second)), "save")).toBe(true);
  });

  it("is absent for a server that did not issue it", async () => {
    const { cell, stored } = memoryCell();
    const { sealer } = makeSystem();
    await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));
    expect(sealedCredential(serverB, sealer).pairingOf(stored())).toEqual(Option.none());
    expect(await Effect.runPromise(storeFor(serverB, sealer, cell).load)).toEqual(Option.none());
  });

  it("keeps the pairing and what is kept for it while the system will not open it", async () => {
    const { system, sealer } = makeSystem();
    const { cell, device, kept } = await pairedWithRecords(sealer);

    system.locked = true;
    const later = await launch(sealer, cell, device);
    await when(later.connection, (state) => state._tag !== "starting");
    expect(later.connection.get()._tag).toBe("storage-failed");
    expect(device.sizes()).toEqual(kept);
    await later.dispose();

    // Restarted once the keyring is unlocked.
    system.locked = false;
    const restarted = await launch(sealer, cell, device);
    await when(restarted.pairing, (pairing) => pairing === first.deviceId);
    await when(restarted.drafts, (drafts) => drafts.size > 0);
    expect([...restarted.drafts.get().values()].map((draft) => draft.text)).toEqual(["keep me"]);
    expect(device.sizes()).toEqual(kept);
    await restarted.dispose();
  });

  it.each([
    ["no sealed token", null],
    ["a sealed token that is not base64", "not base64!"],
    ["a sealed token of no bytes", "A"],
  ])("keeps the pairing and what is kept for it when its record holds %s", async (_, sealed) => {
    const { sealer } = makeSystem();
    const { cell, device, kept } = await pairedWithRecords(sealer);
    await cell.put(
      JSON.stringify({
        deviceId: first.deviceId,
        server: serverA.origin,
        sealed,
        protection: "encrypted",
      }),
    );

    const later = await launch(sealer, cell, device);
    await when(later.connection, (state) => state._tag !== "starting");
    expect(later.connection.get()._tag).toBe("storage-failed");
    expect(device.sizes()).toEqual(kept);
    await later.dispose();
  });

  it("waits for the app once as the client starts", async () => {
    const { cell, device } = await pairedWithRecords(makeSystem().sealer);
    const silent = silentSealer();
    const scope = Scope.makeUnsafe();
    const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope));

    const starting = launch(silent.sealer, cell, device, Layer.succeedContext(clock));
    await when(silent.asked, (count) => count > 0);
    // The deadline is set as the app is asked; once it has passed, the
    // client says it cannot read the sign-in.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Effect.runPromise(TestClock.adjust(SEALER_DEADLINE).pipe(Effect.provideContext(clock)));
    const later = await starting;
    await when(later.connection, (state) => state._tag === "storage-failed");
    expect(silent.asked.get()).toBe(1);
    await later.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
