// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Cell,
  createJ3Client,
  type CredentialStorageError,
  type J3Client,
  type PairingFailure,
  parseServerAddress,
  type Platform,
  type Readable,
  type ServerAddressProblem,
} from "@j3-bots/client-runtime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/**
 * Which server the app runs a client for. `starting` while it reads the
 * stored credential; `unreadable` when secure storage failed to read it, or
 * holds a value that does not decode, so whether this phone is paired is
 * unknown; `none` before the operator named a server; `open` with the client
 * of the server the credential is for, or the one the pairing screen named
 * last.
 */
export type SessionState =
  | { readonly _tag: "starting" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "none" }
  | { readonly _tag: "open"; readonly origin: URL; readonly client: J3Client };

/** What pairing from the pairing screen did. */
type PairOutcome =
  | { readonly _tag: "paired" }
  | { readonly _tag: "address"; readonly problem: ServerAddressProblem }
  | { readonly _tag: "failed"; readonly reason: PairingFailure };

/**
 * The origin of the server the credential is for, if the pairing screen would
 * accept it now: a rule tightened since it was saved applies to it too.
 */
const savedOrigin = (server: string): URL | null => {
  const checked = parseServerAddress(server);
  return Result.isSuccess(checked) && checked.success === server ? new URL(server) : null;
};

/** What the session reads and deletes of the phone's pairing, outside any client. */
export interface SessionDevice {
  /** The server the stored credential is for, if any. Fails when it cannot be read or decoded. */
  readonly storedServer: Effect.Effect<Option.Option<string>, CredentialStorageError>;
  /** Deletes the stored pairing, readable or not, with its drafts and unsent messages. */
  readonly forget: Effect.Effect<void, CredentialStorageError>;
  /** Deletes the files the app opened from its server, which leave the phone with it. */
  readonly forgetFiles: Effect.Effect<void>;
  readonly makePlatform: (origin: URL) => Layer.Layer<Platform>;
  /**
   * Starts ending the phone's pushes for a pairing it left, even one the
   * server still lists, and clearing the notifications that pairing
   * received. It waits on the push service, so the session does not wait for
   * it: a pairing made next is not held up. Never fails.
   */
  readonly endPush: () => void;
}

export interface Session {
  readonly state: Readable<SessionState>;
  /**
   * Whether a pairing from the pairing screen is under way. The screen stays
   * while it is, even as the client of a newly named server starts.
   */
  readonly pairing: Readable<boolean>;
  /**
   * Whether the app is leaving its server for another. Signing out there
   * unpairs the client before it is let go of, and that unpaired client must
   * not show its pairing screen, filled in for the server being left.
   */
  readonly leaving: Readable<boolean>;
  /**
   * Opens the client of the server the device holds a credential for, if any.
   * Called at launch, and again to retry after secure storage failed. A
   * credential for a server the pairing screen would no longer accept is
   * forgotten, with what was kept for it.
   */
  readonly start: () => Promise<void>;
  /**
   * Pairs with the server at `address`, as the operator typed it, with a code
   * from `j3-bots pair` or a paired device. A server other than the one the
   * app runs a client for replaces it.
   */
  readonly pair: (input: {
    readonly address: string;
    readonly code: string;
    readonly deviceName: string;
  }) => Promise<PairOutcome>;
  /**
   * Leaves the server the app runs a client for, so the operator can pair
   * with another: signs this phone out (on the server only if it is
   * connected), which deletes the pairing's drafts, unsent messages and
   * credential here, deletes the files opened from it, and ends its pushes.
   * Resolves `false` when the credential could not be deleted, and the
   * server is kept.
   */
  readonly changeServer: () => Promise<boolean>;
  /**
   * Forgets this phone's sign-in when it cannot be read: deletes the stored
   * credential, with the pairing's drafts, unsent messages and the files
   * opened from it, lets go of any client, so the pairing screen opens, and
   * ends the pairing's pushes. Resolves `false` when the credential could not
   * be deleted.
   */
  readonly forget: () => Promise<boolean>;
}

export const makeSession = (device: SessionDevice): Session => {
  const state = new Cell<SessionState>({ _tag: "starting" });
  const pairing = new Cell(false);
  const leaving = new Cell(false);

  /** One change of client at a time: a pairing that starts while another opens waits for it. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <A>(work: () => Promise<A>): Promise<A> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  const open = async (origin: URL): Promise<J3Client> => {
    const current = state.get();
    if (current._tag === "open") {
      if (current.origin.origin === origin.origin) return current.client;
      await current.client.dispose();
    }
    const client = await createJ3Client(device.makePlatform(origin));
    state.set({ _tag: "open", origin, client });
    return client;
  };

  /** Lets go of any client and shows the pairing screen. */
  const close = async () => {
    const current = state.get();
    if (current._tag === "open") await current.client.dispose();
    state.set({ _tag: "none" });
  };

  /**
   * After the stored pairing was forgotten: none of the files opened from it,
   * the pairing screen, and none of its pushes.
   */
  const left = async () => {
    await Effect.runPromise(device.forgetFiles);
    await close();
    device.endPush();
  };

  /** Whether `effect` succeeded. */
  const succeeds = <E>(effect: Effect.Effect<void, E>) =>
    Effect.runPromise(Effect.isSuccess(effect));

  return {
    state,
    pairing,
    leaving,
    start: () =>
      serially(async () => {
        if (state.get()._tag !== "open") state.set({ _tag: "starting" });
        const read = await Effect.runPromise(Effect.result(device.storedServer));
        if (Result.isFailure(read)) {
          // An unreadable credential is not a missing one: pairing again would
          // replace it and leave its device listed on the server.
          state.set({ _tag: "unreadable" });
        } else if (Option.isNone(read.success)) {
          state.set({ _tag: "none" });
        } else {
          const origin = savedOrigin(read.success.value);
          if (origin !== null) await open(origin);
          // A server the app no longer accepts: its pairing goes before the
          // pairing screen opens, or pairing again would leave it behind.
          else if (await succeeds(device.forget)) await left();
          else state.set({ _tag: "unreadable" });
        }
      }),

    pair: (input) =>
      serially(async (): Promise<PairOutcome> => {
        const parsed = parseServerAddress(input.address);
        if (Result.isFailure(parsed)) return { _tag: "address", problem: parsed.failure };
        pairing.set(true);
        try {
          const client = await open(new URL(parsed.success));
          const result = await client.pair({ code: input.code, deviceName: input.deviceName });
          return result._tag === "paired" ? result : { _tag: "failed", reason: result.reason };
        } finally {
          pairing.set(false);
        }
      }),

    changeServer: () =>
      serially(async () => {
        const current = state.get();
        if (current._tag !== "open") return true;
        leaving.set(true);
        try {
          const result = await current.client.signOut();
          switch (result._tag) {
            case "failed":
              return false;
            // A pairing made meanwhile stays, and the client follows it.
            case "paired-anew":
              return true;
            case "signed-out":
            case "still-listed":
              await Effect.runPromise(device.forgetFiles);
              await current.client.dispose();
              state.set({ _tag: "none" });
              device.endPush();
              return true;
          }
        } finally {
          leaving.set(false);
        }
      }),

    forget: () =>
      serially(async () => {
        if (!(await succeeds(device.forget))) return false;
        await left();
        return true;
      }),
  };
};
