// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceCredential } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import type { TokenProtection } from "@j3-bots/desktop-bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
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

/** IndexedDB's one credential record, in memory. */
const memoryCell = () => {
  let value: unknown;
  const cell: CredentialCell = {
    get: () => Promise.resolve(value),
    put: (next) => {
      value = next;
      return Promise.resolve();
    },
    swap: (expected, next) => {
      if (value !== expected) return Promise.resolve(false);
      value = next ?? undefined;
      return Promise.resolve(true);
    },
  };
  return { cell, stored: () => value };
};

/**
 * The app's sealing, with `keys` standing for the system's key: a sealed
 * token is an opaque name it maps back from, and opens only while that key
 * still holds it.
 */
const sealerWith = (keys: Map<string, string>, tokenProtection: TokenProtection): TokenSealer => ({
  tokenProtection,
  sealToken: (token) => {
    const sealed = btoa(`sealed-${keys.size}`);
    keys.set(sealed, token);
    return Promise.resolve({ sealed, protection: tokenProtection });
  },
  openToken: (sealed) => Promise.resolve(keys.get(sealed) ?? null),
});

const storeFor = (server: URL, sealer: TokenSealer, cell: CredentialCell) =>
  makeCredentialStore({
    codec: sealedCredential(server, sealer),
    cell,
    announce: Effect.void,
    changes: Stream.empty,
  });

describe("the desktop app's credential", () => {
  it("is stored with its token sealed, and reads back", async () => {
    const { cell, stored } = memoryCell();
    const store = storeFor(serverA, sealerWith(new Map(), "encrypted"), cell);
    await Effect.runPromise(store.save(first));
    expect(String(stored())).not.toContain(Redacted.value(first.token));
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
  });

  it("is cleared only while it is still the one stored", async () => {
    const { cell } = memoryCell();
    const store = storeFor(serverA, sealerWith(new Map(), "encrypted"), cell);
    await Effect.runPromise(store.save(first));
    // Another window paired the device again since this one read `second`.
    expect(plain(await Effect.runPromise(store.clear(second)))).toEqual(plain(Option.some(first)));
    expect(await Effect.runPromise(store.clear(first))).toEqual(Option.none());
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
  });

  it("reads as not paired when its token does not open", async () => {
    const { cell } = memoryCell();
    await Effect.runPromise(
      storeFor(serverA, sealerWith(new Map(), "encrypted"), cell).save(first),
    );
    // The key that sealed it is gone, or the record was written by something else.
    const store = storeFor(serverA, sealerWith(new Map(), "encrypted"), cell);
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
    await cell.put(JSON.stringify({ deviceId: "device-1", server: serverA.origin }));
    expect(await Effect.runPromise(store.load)).toEqual(Option.none());
  });

  it("is absent for a server that did not issue it", async () => {
    const { cell, stored } = memoryCell();
    const keys = new Map<string, string>();
    await Effect.runPromise(storeFor(serverA, sealerWith(keys, "encrypted"), cell).save(first));
    const elsewhere = sealedCredential(serverB, sealerWith(keys, "encrypted"));
    expect(elsewhere.pairingOf(stored())).toEqual(Option.none());
    expect(
      await Effect.runPromise(storeFor(serverB, sealerWith(keys, "encrypted"), cell).load),
    ).toEqual(Option.none());
  });

  it("is sealed again once the system can encrypt what it once only obscured", async () => {
    const { cell, stored } = memoryCell();
    const keys = new Map<string, string>();
    await Effect.runPromise(storeFor(serverA, sealerWith(keys, "unencrypted"), cell).save(first));
    const store = storeFor(serverA, sealerWith(keys, "encrypted"), cell);
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
    expect(JSON.parse(String(stored()))).toMatchObject({ protection: "encrypted" });
    expect(plain(await Effect.runPromise(store.load))).toEqual(plain(Option.some(first)));
  });
});
