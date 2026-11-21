// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Cell,
  createJ3Client,
  type J3Client,
  type PairingFailure,
  parseServerAddress,
  type Readable,
  type ServerAddressProblem,
} from "@j3-bots/client-runtime";
import * as Result from "effect/Result";
import { makePlatform, secureCredential } from "./platform/platform.ts";
import { storedServer } from "./platform/storage.ts";

/**
 * Which server the app runs a client for. `starting` while it reads the
 * stored credential; `none` before the operator named a server; `open` with
 * the client of the server the credential is for, or the one the pairing
 * screen named last.
 */
export type SessionState =
  | { readonly _tag: "starting" }
  | { readonly _tag: "none" }
  | { readonly _tag: "open"; readonly origin: URL; readonly client: J3Client };

/** What pairing from the pairing screen did. */
type PairOutcome =
  | { readonly _tag: "paired" }
  | { readonly _tag: "address"; readonly problem: ServerAddressProblem }
  | { readonly _tag: "failed"; readonly reason: PairingFailure };

const state = new Cell<SessionState>({ _tag: "starting" });
const pairing = new Cell(false);

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
  const client = await createJ3Client(makePlatform(origin));
  state.set({ _tag: "open", origin, client });
  return client;
};

export interface Session {
  readonly state: Readable<SessionState>;
  /**
   * Whether a pairing from the pairing screen is under way. The screen stays
   * while it is, even as the client of a newly named server starts.
   */
  readonly pairing: Readable<boolean>;
  /** Opens the client of the server the device holds a credential for, if any. */
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
}

export const session: Session = {
  state,
  pairing,
  start: () =>
    serially(async () => {
      const server = await storedServer(secureCredential).catch(() => null);
      const origin = server === null ? null : URL.parse(server);
      if (origin === null) state.set({ _tag: "none" });
      else await open(origin);
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
};
