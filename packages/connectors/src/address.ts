// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Address ranges are matched with node:net's BlockList, which has no Effect API.
import * as NodeNet from "node:net";

/**
 * Which addresses a connector may reach. A connector's server is somewhere on
 * the internet; the J3 Bots server sits in the operator's network, so an
 * address that points back into it (the router, a NAS, the cloud metadata
 * service, the server itself) is refused, however the name that led there was
 * spelled.
 */

const blockList = (ranges: ReadonlyArray<readonly [string, number]>, family: "ipv4" | "ipv6") => {
  const list = new NodeNet.BlockList();
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, family);
  return list;
};

/**
 * IPv4 ranges that are not public unicast (IANA special-purpose registry):
 * "this network", private, shared (carrier NAT), loopback, link-local,
 * protocol assignments, documentation, benchmarking, multicast, reserved and
 * broadcast.
 */
const NOT_PUBLIC_V4 = blockList(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ],
  "ipv4",
);

/**
 * IPv6 ranges that are not public unicast: unspecified, loopback, discard,
 * the IPv4/IPv6 translation and tunnelling prefixes (Teredo, 6to4, ORCHID),
 * documentation, unique-local, link-local, the deprecated site-local and
 * multicast. Only global unicast (`2000::/3`) outside those is public.
 */
const NOT_PUBLIC_V6 = blockList(
  [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ],
  "ipv6",
);

const GLOBAL_UNICAST_V6 = blockList([["2000::", 3]], "ipv6");

/**
 * Cloud metadata services, which hand out the machine's credentials. Most
 * answer at link-local addresses, never allowed anyway; these sit inside a
 * private network's ranges, or in public space, so an operator's
 * confirmation must not open them: Alibaba Cloud's (`100.100.100.200`),
 * Azure's platform endpoint (`168.63.129.16`), and the IPv6 addresses of
 * AWS (`fd00:ec2::254`, and `fd00:ec2::23` for EKS Pod Identity), Google
 * Cloud (`fd20:ce::254`), Oracle Cloud (`fd00:c1::a9fe:a9fe`) and Akamai
 * (`fd00:a9fe:a9fe::1`).
 */
const METADATA = (() => {
  const list = new NodeNet.BlockList();
  for (const address of ["100.100.100.200", "168.63.129.16"]) list.addAddress(address, "ipv4");
  for (const address of [
    "fd00:ec2::254",
    "fd00:ec2::23",
    "fd20:ce::254",
    "fd00:c1::a9fe:a9fe",
    "fd00:a9fe:a9fe::1",
  ]) {
    list.addAddress(address, "ipv6");
  }
  return list;
})();

const LOOPBACK_V4 = blockList([["127.0.0.0", 8]], "ipv4");

/** A home or office network's own ranges: private, carrier NAT, and IPv6 unique-local. */
const PRIVATE_NETWORK_V4 = blockList(
  [
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
  ],
  "ipv4",
);
const PRIVATE_NETWORK_V6 = blockList([["fc00::", 7]], "ipv6");

/** `::ffff:a.b.c.d` and `::ffff:XXXX:XXXX`: an IPv4 address in IPv6 form, judged as that IPv4 address. */
const mappedIpv4 = (address: string): string | null => {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const rest = lower.slice("::ffff:".length);
  if (NodeNet.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

/** An IP literal's family, after unwrapping an IPv4-mapped IPv6 address. */
const classify = (
  address: string,
): { readonly family: "ipv4" | "ipv6"; readonly address: string } | null => {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const mapped = mappedIpv4(bare);
  if (mapped !== null) return { family: "ipv4", address: mapped };
  if (NodeNet.isIPv4(bare)) return { family: "ipv4", address: bare };
  if (NodeNet.isIPv6(bare)) return { family: "ipv6", address: bare };
  return null;
};

/** Whether `address`, an IP literal, is a public unicast address. Anything else, a name included, is not. */
export const isPublicAddress = (address: string): boolean => {
  const ip = classify(address);
  if (ip === null || METADATA.check(ip.address, ip.family)) return false;
  if (ip.family === "ipv4") return !NOT_PUBLIC_V4.check(ip.address, "ipv4");
  return GLOBAL_UNICAST_V6.check(ip.address, "ipv6") && !NOT_PUBLIC_V6.check(ip.address, "ipv6");
};

/**
 * Whether `address`, an IP literal, is in a private network's own ranges,
 * which an operator may allow for a connector they confirmed is theirs.
 * Loopback, link-local (where most cloud metadata services answer), reserved
 * and cloud metadata addresses are not among them.
 */
export const isPrivateNetworkAddress = (address: string): boolean => {
  const ip = classify(address);
  if (ip === null || METADATA.check(ip.address, ip.family)) return false;
  return ip.family === "ipv4"
    ? PRIVATE_NETWORK_V4.check(ip.address, "ipv4")
    : PRIVATE_NETWORK_V6.check(ip.address, "ipv6");
};

/** Whether `address`, an IP literal, is this machine's loopback. */
export const isLoopbackAddress = (address: string): boolean => {
  const ip = classify(address);
  if (ip === null) return false;
  return ip.family === "ipv4" ? LOOPBACK_V4.check(ip.address, "ipv4") : ip.address === "::1";
};

/** Whether `host`, as a URL's hostname gives it, is an IP literal rather than a name. */
export const isAddressLiteral = (host: string): boolean => classify(host) !== null;
