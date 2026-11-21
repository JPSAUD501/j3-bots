// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- IP literals are classified with node:net's parser and BlockList, as the server classifies its own.
import * as NodeNet from "node:net";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Where plain HTTP is acceptable, as the server decides where it serves it:
 * loopback, the private IPv4 ranges, link-local, carrier-grade NAT (where
 * Tailscale puts its addresses), and IPv6 loopback, unique-local and
 * link-local.
 */
const PRIVATE = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether plain HTTP to `hostname` (as a URL holds it, an IPv6 literal in
 * brackets) stays on this machine or a private network. Only `localhost`,
 * which the browser always resolves to loopback, and an IP literal qualify: a
 * host name could resolve anywhere.
 */
const isPrivateHost = (hostname: string): boolean => {
  if (hostname === "localhost") return true;
  const literal = hostname.replace(/^\[(.*)\]$/, "$1");
  if (NodeNet.isIPv4(literal)) return PRIVATE.check(literal, "ipv4");
  if (NodeNet.isIPv6(literal)) return PRIVATE.check(literal, "ipv6");
  return false;
};

const decodeOrigin = Schema.decodeUnknownOption(ServerOrigin);

/**
 * The server origin an address the operator typed names. Without a scheme it
 * is `http:` for a private host and `https:` for any other. A path, a query,
 * a fragment or a user name is refused: the server lives at an origin's root.
 * Plain HTTP is accepted only to a private host (`needs-https` otherwise),
 * since the device token would cross the network in the clear.
 */
export const parseServerAddress = (
  typed: string,
): Result.Result<ServerOrigin, "invalid" | "needs-https"> => {
  const text = typed.trim();
  if (text === "") return Result.fail("invalid");
  const schemed = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  const probe = URL.parse(schemed ? text : `http://${text}`);
  if (probe === null) return Result.fail("invalid");
  const url = schemed
    ? probe
    : URL.parse(`${isPrivateHost(probe.hostname) ? "http" : "https"}://${text}`);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return Result.fail("invalid");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) return Result.fail("needs-https");
  const origin = decodeOrigin(url.origin);
  return Option.isSome(origin) ? Result.succeed(origin.value) : Result.fail("invalid");
};
