// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { PairingCode } from "./device.ts";

/**
 * `text` as a URL, or none when it is not one. Built on `new URL`: `URL.parse`
 * is missing from Safari before 18 and from some JavaScript engines a native
 * client runs on.
 */
export const parseUrl: (text: string) => Option.Option<URL> = Option.liftThrowable(
  (text: string) => new URL(text),
);

const isHttp = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

/** An `http:` or `https:` origin: scheme, host and port, nothing more. */
export const ServerOrigin = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      Option.exists(parseUrl(text), (url) => isHttp(url) && url.origin === text) ||
      "an http: or https: origin",
  ),
).pipe(Schema.brand("ServerOrigin"));
export type ServerOrigin = typeof ServerOrigin.Type;

const decodeOrigin = Schema.decodeUnknownOption(ServerOrigin);

/**
 * An address typed as a bare http or https origin, as the origin, or none. A
 * trailing `/` is the only path it may have, and it has no query, fragment or
 * user name, not even an empty one: a URL writes back exactly as its origin
 * and `/` only then. Letter case and a default port are a browser's to write.
 */
export const bareServerOrigin = (text: string): Option.Option<ServerOrigin> =>
  Option.flatMap(parseUrl(text.trim()), (url) =>
    url.href === `${url.origin}/` ? decodeOrigin(url.origin) : Option.none(),
  );

/** What a pairing link carries: where the server is, and the code to pair with there. */
export const PairingLinkTarget = Schema.Struct({ server: ServerOrigin, code: PairingCode });
export type PairingLinkTarget = typeof PairingLinkTarget.Type;

/** The path a pairing link opens, which only the web client's loading page reads. */
export const PAIRING_PATH = "/pair";

/**
 * `<origin>/pair#<code>` exactly: the origin as a browser writes it, the path
 * `/pair`, no query or user name, and a fragment that is the code alone.
 * Whether the code has a code's form is the target's to check.
 */
const isPairingLinkText = (text: string) =>
  Option.exists(
    parseUrl(text),
    (url) => isHttp(url) && text === `${url.origin}${PAIRING_PATH}${url.hash}`,
  ) || "an http: or https: origin, then /pair# and a code";

/**
 * A link that pairs a new client: the server's own address at `/pair`, with
 * the pairing code as the fragment, as a QR code carries them to a phone's
 * camera. A camera opens it in the browser, where the web client takes the
 * code from the fragment; a native client's scanner reads the same link. The
 * path is the link's own so that opening one always loads the page, even in
 * a tab already showing the app, where a new fragment alone would not. The
 * fragment never reaches the server, so the code stays out of its logs and of
 * `Referer`. A link only fills in the pairing screen: a client never pairs
 * from one by itself. The code still works once and expires as any code does.
 */
export const PairingLink = Schema.String.check(Schema.makeFilter(isPairingLinkText)).pipe(
  Schema.decodeTo(PairingLinkTarget, {
    decode: SchemaGetter.transform((text: string) => {
      const url = new URL(text);
      return { server: url.origin, code: url.hash.slice(1) };
    }),
    encode: SchemaGetter.transform(
      ({ server, code }: { readonly server: string; readonly code: string }) =>
        `${server}${PAIRING_PATH}#${code}`,
    ),
  }),
);

/** An IPv4 address an IPv6 URL host maps, as `[::ffff:7f00:1]`, in dotted form. */
const mappedIpv4 = (hostname: string) => {
  const groups = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(hostname);
  if (groups === null) return hostname;
  const [high, low] = [Number.parseInt(groups[1]!, 16), Number.parseInt(groups[2]!, 16)];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
};

/**
 * Hosts that name the machine reading them, so never another device's way to
 * the server: loopback, and the unspecified address, which reaches it too. A
 * name's one final dot, as in `localhost.`, names the same host.
 */
const isSelf = (hostname: string) => {
  const host = mappedIpv4(hostname.endsWith(".") ? hostname.slice(0, -1) : hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
};

/**
 * The origins a pairing link can carry to another device, best first, each
 * once. The one this client reaches the server at (`current`) comes first
 * when it is `https:`, as a domain a proxy serves, or one the server offers;
 * a plain-HTTP origin the server does not offer, as a forwarded port, is left
 * out. Then those the server offers, in its order. An origin that names the
 * reading device itself, as loopback does, is left out.
 */
export const pairingOrigins = (
  offered: ReadonlyArray<ServerOrigin>,
  current?: ServerOrigin,
): ReadonlyArray<ServerOrigin> => {
  const first =
    current !== undefined && (current.startsWith("https:") || offered.includes(current))
      ? [current]
      : [];
  return [...new Set([...first, ...offered])].filter((origin) => !isSelf(new URL(origin).hostname));
};
