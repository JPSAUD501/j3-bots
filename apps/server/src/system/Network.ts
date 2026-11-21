// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Interface addresses, IP parsing and the accepted socket's address come only from node:os and node:net.
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import { ServerOrigin } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NetAddress from "effect/net/NetAddress";

/** One IPv4 address of this machine. `internal` is loopback. */
export interface InterfaceAddress {
  /** The interface it belongs to, such as `eth0`, `wlan0` or `docker0`. */
  readonly interface: string;
  readonly address: string;
  readonly internal: boolean;
}

/** The machine's IPv4 addresses, read when asked: interfaces come and go. */
export class Network extends Context.Service<
  Network,
  { readonly ipv4Addresses: Effect.Effect<ReadonlyArray<InterfaceAddress>> }
>()("@j3-bots/server/system/Network") {}

export const layer = Layer.succeed(
  Network,
  Network.of({
    ipv4Addresses: Effect.sync(() =>
      Object.entries(NodeOs.networkInterfaces()).flatMap(([name, addresses]) =>
        (addresses ?? []).flatMap((entry) =>
          entry.family === "IPv4"
            ? [{ interface: name, address: entry.address, internal: entry.internal }]
            : [],
        ),
      ),
    ),
  }),
);

/**
 * Where plain HTTP is acceptable: loopback, the private IPv4 ranges,
 * link-local, carrier-grade NAT (where Tailscale puts its addresses), and IPv6
 * loopback, unique-local and link-local.
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

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/**
 * Whether plain HTTP is acceptable on `address`. Only an IP literal in the
 * form Node binds and reports qualifies: a host name could resolve anywhere,
 * and an unspecified address (`0.0.0.0`, `::`) listens on every interface,
 * public ones included. An IPv4-mapped IPv6 address, as a dual-stack socket
 * reports it, is judged as its IPv4 address.
 */
export const isPrivateAddress = (address: string): boolean => {
  const mapped = MAPPED_IPV4.exec(address)?.[1];
  if (mapped !== undefined && NodeNet.isIPv4(mapped)) return PRIVATE.check(mapped, "ipv4");
  if (NodeNet.isIPv4(address)) return PRIVATE.check(address, "ipv4");
  if (NodeNet.isIPv6(address)) return PRIVATE.check(address, "ipv6");
  return false;
};

/** The address that listens on every IPv4 interface. */
export const EVERY_IPV4_INTERFACE = "0.0.0.0";

/** Interfaces of containers and virtual networks, which no other device reaches the server through. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|virbr|cni|flannel|cali|podman)/;

/**
 * The hosts another device reaches a listener at, best first. Over HTTPS a
 * browser accepts only a name on the certificate (`names`), so no bare
 * address is offered; over HTTP, the address bound or, for every IPv4
 * interface (`0.0.0.0`), the private addresses of this machine's real
 * interfaces. Empty when there is none.
 */
const reachableHosts = Effect.fn("Network.reachableHosts")(function* (listener: {
  readonly scheme: "http" | "https";
  readonly address: string;
  readonly names: ReadonlyArray<string>;
}) {
  if (listener.scheme === "https") return listener.names;
  if (listener.address !== EVERY_IPV4_INTERFACE) return [listener.address];
  const network = yield* Network;
  return (yield* network.ipv4Addresses)
    .filter(
      (entry) =>
        !entry.internal &&
        !VIRTUAL_INTERFACE.test(entry.interface) &&
        isPrivateAddress(entry.address),
    )
    .map((entry) => entry.address);
});

const decodeOrigin = Schema.decodeUnknownOption(ServerOrigin);

/**
 * The origins another device reaches a listener at, best first: one for each
 * of its `reachableHosts`, at the port it bound, as a browser writes it (no
 * default port). Empty when there is none.
 */
export const reachableOrigins = Effect.fn("Network.reachableOrigins")(function* (listener: {
  readonly scheme: "http" | "https";
  readonly address: string;
  readonly port: number;
  readonly names: ReadonlyArray<string>;
}) {
  const hosts = yield* reachableHosts(listener);
  return hosts.flatMap((host) => {
    const url = URL.parse(
      `${listener.scheme}://${NetAddress.formatUrlHostString(host)}:${listener.port}`,
    );
    return url === null ? [] : Option.toArray(decodeOrigin(url.origin));
  });
});

/**
 * What stands for the host of an HTTPS listener whose certificate names none
 * `reachableHosts` offers: the operator puts in the name they reach it at.
 */
export const CERTIFICATE_NAME = "<a name the server's certificate covers>";

/**
 * Destroys, as it is accepted and before any of its bytes is read, every
 * connection whose local address `allows` refuses. A listener on every
 * interface checks the address each connection actually reached, so an
 * address that appears after the server started is never served.
 */
export const guardConnections = (
  server: NodeNet.Server,
  allows: (localAddress: string) => boolean,
) => {
  server.prependListener("connection", (socket: NodeNet.Socket) => {
    const local = socket.localAddress;
    if (local === undefined || !allows(local)) socket.destroy();
  });
};
