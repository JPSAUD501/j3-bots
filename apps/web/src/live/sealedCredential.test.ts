// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Cell,
  ClientStorage,
  CredentialStore,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it } from "vite-plus/test";
import { type CredentialCell, makeCredentialStore } from "./credentialStore";
import { sealedCredential, type TokenSealer } from "./sealedCredential";

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

/** IndexedDB's one credential record, in memory. `beforeSwap` runs as each swap starts. */
const memoryCell = (beforeSwap: () => Promise<void> = () => Promise.resolve()) => {
  let value: unknown;
  const cell: CredentialCell = {
    get: () => Promise.resolve(value),
    put: (next) => {
      value = next;
      return Promise.resolve();
    },
    swap: async (expected, next) => {
      await beforeSwap();
      if (value !== expected) return false;
      value = next ?? undefined;
      return true;
    },
  };
  return { cell, stored: () => value };
};

/**
 * The system that seals the token for the app. Its key changes with `epoch`:
 * what was sealed under an earlier one still opens, and should be sealed
 * again. While `locked`, it opens nothing, as a locked keyring.
 */
const makeSystem = () => {
  const sealedTokens = new Map<string, { readonly token: string; readonly epoch: number }>();
  const system = { epoch: 0, protection: "encrypted" as TokenProtection, locked: false };
  const sealer: TokenSealer = {
    sealToken: (token) => {
      const sealed = btoa(`sealed-${sealedTokens.size}`);
      sealedTokens.set(sealed, { token, epoch: system.epoch });
      return Promise.resolve({ sealed, protection: system.protection });
    },
    openToken: (sealed) => {
      const found = sealedTokens.get(sealed);
      const opened: OpenResult = system.locked
        ? { _tag: "unavailable" }
        : found === undefined
          ? { _tag: "failed" }
          : { _tag: "opened", token: found.token, stale: found.epoch < system.epoch };
      return Promise.resolve(opened);
    },
  };
  return { system, sealer };
};

const storeFor = (server: URL, sealer: TokenSealer, cell: CredentialCell) =>
  makeCredentialStore({
    codec: sealedCredential(server, sealer),
    cell,
    announce: Effect.void,
    changes: Stream.empty,
  });

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
  return { storage, size: (name: LocalTable) => table(name).size, writes };
};

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
    expect(plain(await Effect.runPromise(store.clear(second)))).toEqual(plain(Option.some(first)));
    expect(await Effect.runPromise(store.clear(first))).toEqual(Option.none());
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
  });

  it("is cleared though another window sealed it again between the read and the delete", async () => {
    const { system, sealer } = makeSystem();
    let otherWindow = () => Promise.resolve();
    const { cell, stored } = memoryCell(() => otherWindow());
    await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));
    system.epoch += 1;
    // As this window is about to delete it, another reads it and seals it again under the new key.
    otherWindow = async () => {
      otherWindow = () => Promise.resolve();
      await Effect.runPromise(storeFor(serverA, sealer, cell).load);
    };
    expect(await Effect.runPromise(storeFor(serverA, sealer, cell).clear(first))).toEqual(
      Option.none(),
    );
    expect(stored()).toBeUndefined();
  });

  it("reads as not paired when its token is not one the app sealed", async () => {
    const { cell } = memoryCell();
    await Effect.runPromise(storeFor(serverA, makeSystem().sealer, cell).save(first));
    // Sealed by another profile, or written by something else.
    const store = storeFor(serverA, makeSystem().sealer, cell);
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
    await cell.put(JSON.stringify({ deviceId: "device-1", server: serverA.origin }));
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
  });

  it("is absent for a server that did not issue it", async () => {
    const { cell, stored } = memoryCell();
    const { sealer } = makeSystem();
    await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));
    expect(sealedCredential(serverB, sealer).pairingOf(stored())).toEqual(Option.none());
    expect(await Effect.runPromise(storeFor(serverB, sealer, cell).load)).toEqual(Option.none());
  });

  it("is sealed again when the system says its key changed", async () => {
    const { cell, stored } = memoryCell();
    const { system, sealer } = makeSystem();
    system.protection = "unencrypted";
    const store = storeFor(serverA, sealer, cell);
    await Effect.runPromise(store.save(first));
    // A keyring the app can use now: the system encrypts with its key.
    system.epoch += 1;
    system.protection = "encrypted";
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
    expect(JSON.parse(String(stored()))).toMatchObject({ protection: "encrypted" });
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
  });

  it("keeps the pairing and what is kept for it while the system will not open it", async () => {
    const { cell, stored } = memoryCell();
    const { system, sealer } = makeSystem();
    const codec = sealedCredential(serverA, sealer);
    const device = memoryStorage(() => codec.pairingOf(stored()));
    const target: EntryTarget = { _tag: "conversation", botId: BotId.make("bot-1") };
    const launch = () =>
      createJ3Client(
        Layer.mergeAll(
          Layer.succeed(ServerAddress, { origin: serverA }),
          Layer.succeed(
            CredentialStore,
            makeCredentialStore({ codec, cell, announce: Effect.void, changes: Stream.never }),
          ),
          Layer.succeed(ClientStorage, device.storage),
          Layer.succeed(WindowLocks, makeInProcessLocks()),
          Layer.succeed(
            FileTransfer,
            FileTransfer.of({ upload: () => Effect.fail(new TransferFailed()) }),
          ),
          // Offline: the client never reaches for a server.
          Layer.succeed(
            Network,
            Network.of({ status: Effect.succeed("offline"), changes: Stream.never }),
          ),
          FetchHttpClient.layer,
          Socket.layerWebSocketConstructorGlobal,
          SecureRandom.layerWebCrypto,
        ),
      );
    await Effect.runPromise(storeFor(serverA, sealer, cell).save(first));

    const earlier = await launch();
    await when(earlier.pairing, (pairing) => pairing === first.deviceId);
    earlier.setDraftText(target, "keep me");
    void earlier.send({ target, text: "on its way" });
    await when(device.writes, () => device.size("drafts") > 0 && device.size("outbox") > 0);
    await earlier.dispose();
    const kept = [device.size("drafts"), device.size("outbox")];

    system.locked = true;
    const later = await launch();
    await when(later.connection, (state) => state._tag !== "starting");
    expect(later.connection.get()._tag).toBe("storage-failed");
    expect([device.size("drafts"), device.size("outbox")]).toEqual(kept);

    system.locked = false;
    later.reconnectNow();
    await when(later.pairing, (pairing) => pairing === first.deviceId);
    await when(later.drafts, (drafts) => drafts.size > 0);
    expect([...later.drafts.get().values()].map((draft) => draft.text)).toEqual(["keep me"]);
    expect([device.size("drafts"), device.size("outbox")]).toEqual(kept);
    await later.dispose();
  });
});
