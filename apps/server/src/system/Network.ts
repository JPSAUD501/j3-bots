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

/** A `Host` header holds an authority alone: no user, path, query or fragment. */
const AUTHORITY = /^[^\s@/\\?#]+$/;

/**
 * Whether a plain-HTTP listener answers a request whose `Host` header is
 * `host`. A web page on a name its owner points at this machine's address
 * (DNS rebinding) is same-origin with the server under that name, so it could
 * read what the server answers, and its browser sends that name as `Host`.
 * No one can rebind an IP literal, nor `localhost`, which browsers resolve to
 * loopback themselves, and `publicOrigin` names the operator's own domain. So
 * the host must be one of those. Its port is not compared: the name is what a
 * rebinding page cannot fake, and a proxy, Docker or an emulator may reach the
 * server at a port other than the one it bound.
 */
export const isServedHost = (
  host: string | undefined,
  publicOrigin: Option.Option<ServerOrigin>,
): boolean => {
  if (host === undefined || !AUTHORITY.test(host)) return false;
  const url = URL.parse(`http://${host}`);
  if (url === null) return false;
  const name = url.hostname;
  return (
    name === "localhost" ||
    NodeNet.isIP(name.startsWith("[") ? name.slice(1, -1) : name) !== 0 ||
    Option.exists(publicOrigin, (origin) => URL.parse(origin)?.hostname === name)
  );
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
 * The origins another device reaches the server at, best first, each once:
 * its public origin, when one is set (`publicOrigin` in `config.json`), then
 * one for each of the listener's `reachableHosts`, at the port it bound, as a
 * browser writes it (no default port). Empty when there is none.
 */
export const reachableOrigins = Effect.fn("Network.reachableOrigins")(function* (
  listener: {
    readonly scheme: "http" | "https";
    readonly address: string;
    readonly port: number;
    readonly names: ReadonlyArray<string>;
  },
  publicOrigin: Option.Option<ServerOrigin>,
) {
  const hosts = yield* reachableHosts(listener);
  const listened = hosts.flatMap((host) => {
    const url = URL.parse(
      `${listener.scheme}://${NetAddress.formatUrlHostString(host)}:${listener.port}`,
    );
    return url === null ? [] : Option.toArray(decodeOrigin(url.origin));
  });
  return [...new Set([...Option.toArray(publicOrigin), ...listened])];
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
