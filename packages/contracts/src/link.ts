// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { PairingCode } from "./device.ts";

/** An `http:` or `https:` origin: scheme, host and port, nothing more. */
export const ServerOrigin = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const url = URL.parse(text);
    return (
      (url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === text) ||
      "an http: or https: origin"
    );
  }),
).pipe(Schema.brand("ServerOrigin"));
export type ServerOrigin = typeof ServerOrigin.Type;

/** What a pairing link carries: where the server is, and the code to pair with there. */
export const PairingLinkTarget = Schema.Struct({ server: ServerOrigin, code: PairingCode });
export type PairingLinkTarget = typeof PairingLinkTarget.Type;

/** The scheme and host of a pairing link. Each client resolves `j3bots://` links itself. */
const PAIRING_LINK_BASE = "j3bots://pair";

/**
 * `j3bots://pair?server=<origin>&code=<code>`, each parameter once and nothing
 * else: no path, port, user name or fragment. What the parameters hold is the
 * target's to check.
 */
const isPairingLinkText = (text: string) => {
  const url = URL.parse(text);
  if (
    url === null ||
    url.protocol !== "j3bots:" ||
    url.host !== "pair" ||
    url.pathname !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    text.includes("#")
  ) {
    return "a j3bots://pair link";
  }
  const keys = [...url.searchParams.keys()].toSorted();
  return (
    (keys.length === 2 && keys[0] === "code" && keys[1] === "server") ||
    "server and code, once each"
  );
};

/**
 * A link that pairs a new client: the server's origin and a pairing code, as a
 * QR code carries them to a phone's camera. It pre-fills the pairing screen;
 * a client never pairs from a link by itself. The code still works once and
 * expires as any code does.
 */
export const PairingLink = Schema.String.check(Schema.makeFilter(isPairingLinkText)).pipe(
  Schema.decodeTo(PairingLinkTarget, {
    decode: SchemaGetter.transform((text: string) => {
      const params = new URL(text).searchParams;
      return { server: params.get("server") ?? "", code: params.get("code") ?? "" };
    }),
    encode: SchemaGetter.transform(
      ({ server, code }: { readonly server: string; readonly code: string }) =>
        `${PAIRING_LINK_BASE}?${new URLSearchParams({ server, code })}`,
    ),
  }),
);

/** Hosts that name the machine reading them, so never another device's way to the server. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * The origins a pairing link can carry to another device, best first: the one
 * this client reaches the server at (`current`), then those the server
 * offers, each once. A loopback origin is left out: on the device that reads
 * the link, it names that device.
 */
export const pairingOrigins = (
  offered: ReadonlyArray<ServerOrigin>,
  current?: ServerOrigin,
): ReadonlyArray<ServerOrigin> =>
  [...new Set(current === undefined ? offered : [current, ...offered])].filter(
    (origin) => !isLoopback(new URL(origin).hostname),
  );
