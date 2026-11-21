// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Result from "effect/Result";

// Which server an address the operator typed names, for the clients that ask
// for one: the desktop app and the mobile app. Free of any platform: the WHATWG
// URL parser, which every platform has, already writes an IP literal in its one
// canonical form, so the ranges below are checked on that form.

/** `a.b.c.d`, each part 0–255, as the URL parser writes an IPv4 host. */
const ipv4Parts = (hostname: string): ReadonlyArray<number> | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
};

/**
 * Where plain HTTP is acceptable, as the server decides where it serves it:
 * loopback, the private ranges, link-local, and carrier-grade NAT (where
 * Tailscale puts its addresses).
 */
const isPrivateIpv4 = ([a = -1, b = -1]: ReadonlyArray<number>): boolean =>
  a === 127 ||
  a === 10 ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  (a === 169 && b === 254) ||
  (a === 100 && b >= 64 && b <= 127);

/** The eight 16-bit groups of an IPv6 literal as the URL parser writes it, or `null`. */
const ipv6Groups = (literal: string): ReadonlyArray<number> | null => {
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined) =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => "0"),
    ...tail,
  ];
  if (!all.every((group) => /^[\da-f]{1,4}$/.test(group))) return null;
  return all.map((group) => Number.parseInt(group, 16));
};

/**
 * IPv6 loopback, unique-local and link-local, and an IPv4 address written as
 * IPv6 (`::ffff:a.b.c.d`) when the IPv4 address qualifies.
 */
const isPrivateIpv6 = (groups: ReadonlyArray<number>): boolean => {
  const [first = 0] = groups;
  const leadingZeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (leadingZeros(7) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  if (leadingZeros(5) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0;
    return isPrivateIpv4([high >> 8, high & 0xff]);
  }
  return false;
};

/**
 * Whether plain HTTP to `hostname` (as a URL holds it, an IPv6 literal in
 * brackets) stays on this machine or a private network. Only `localhost`,
 * which always names loopback, and an IP literal qualify: a host name could
 * resolve anywhere.
 */
const isPrivateHost = (hostname: string): boolean => {
  if (hostname === "localhost") return true;
  const ipv4 = ipv4Parts(hostname);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  const bracketed = /^\[(.*)\]$/.exec(hostname);
  if (bracketed?.[1] === undefined) return false;
  const ipv6 = ipv6Groups(bracketed[1]);
  return ipv6 !== null && isPrivateIpv6(ipv6);
};

/** Why an address the operator typed names no server this client may use. */
export type ServerAddressProblem = "invalid" | "needs-https";

/**
 * The origin of the server an address the operator typed names. Without a
 * scheme it is `http:` for a private host and `https:` for any other. A path,
 * a query, a fragment or a user name is refused: the server lives at an
 * origin's root. Plain HTTP is accepted only to a private host
 * (`needs-https` otherwise), since the device token would cross the network in
 * the clear.
 */
export const parseServerAddress = (typed: string): Result.Result<string, ServerAddressProblem> => {
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
  return Result.succeed(url.origin);
};
