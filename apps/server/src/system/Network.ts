// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The machine's interface addresses come only from node:os.
import * as NodeOs from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** One IPv4 address of this machine. `internal` is loopback. */
export interface InterfaceAddress {
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
      Object.values(NodeOs.networkInterfaces()).flatMap((addresses) =>
        (addresses ?? []).flatMap((entry) =>
          entry.family === "IPv4" ? [{ address: entry.address, internal: entry.internal }] : [],
        ),
      ),
    ),
  }),
);

const ipv4 = (host: string) => {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

/**
 * Whether plain HTTP is acceptable on `host`: loopback, the private IPv4
 * ranges, link-local, carrier-grade NAT (where Tailscale puts its addresses),
 * and IPv6 loopback, unique-local and link-local addresses. An unspecified
 * address (`0.0.0.0`, `::`) listens everywhere, public interfaces included,
 * and a host name could resolve anywhere, so neither qualifies.
 */
export const isPrivateHost = (host: string): boolean => {
  if (host === "localhost") return true;
  const octets = ipv4(host);
  if (octets !== undefined) {
    const [a = -1, b = -1] = octets;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = host.toLowerCase().replace(/^\[|\]$/g, "");
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
};
