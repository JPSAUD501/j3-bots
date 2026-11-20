// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface ServerConfigShape {
  /**
   * Where J3 Bots keeps its state: the database, the bot workspaces and the
   * engine's own data directory. Never inside a Git checkout, or the engine
   * treats every bot workspace as part of that repository.
   */
  readonly home: string;
  readonly databasePath: string;
  /** Loopback by default. Anything wider is the operator's choice. */
  readonly host: string;
  readonly port: number;
  /** A certificate and key to serve HTTPS with. Required on a public address. */
  readonly tls: Option.Option<{ readonly certPath: string; readonly keyPath: string }>;
  /** The loopback port the engine listens on. */
  readonly enginePort: number;
  /** An engine executable to use instead of the pinned one J3 Bots installs. */
  readonly engineBinary: Option.Option<string>;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@j3-bots/server/config/ServerConfig",
) {}

/** The configuration names a setting J3 Bots will not run with. */
class ConfigRefused extends Schema.TaggedError<ConfigRefused>()("ConfigRefused", {
  setting: Schema.String,
  reason: Schema.Literals(["home-in-git-checkout", "public-address-without-tls", "tls-incomplete"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "home-in-git-checkout":
        return `${this.setting} is inside a Git checkout. Choose a folder outside any repository.`;
      case "public-address-without-tls":
        return `${this.setting} is not a loopback or private address. Set J3_TLS_CERT and J3_TLS_KEY to serve it over HTTPS.`;
      case "tls-incomplete":
        return "J3_TLS_CERT and J3_TLS_KEY must be set together.";
    }
  }
}

const DEFAULT_PORT = 3737;
const DEFAULT_ENGINE_PORT = 3738;

// A default applies only when a setting is absent. A setting that is present
// and invalid fails the start, so a typo never silently becomes the default.
const environment = Config.all({
  home: Config.option(Config.NonEmptyString("J3_HOME")),
  host: Config.NonEmptyString("J3_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("J3_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  tlsCert: Config.option(Config.NonEmptyString("J3_TLS_CERT")),
  tlsKey: Config.option(Config.NonEmptyString("J3_TLS_KEY")),
  enginePort: Config.Port("J3_ENGINE_PORT").pipe(Config.withDefault(DEFAULT_ENGINE_PORT)),
  engineBinary: Config.option(Config.NonEmptyString("J3_ENGINE_BINARY")),
});

const ipv4 = (host: string) => {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

/**
 * Whether plain HTTP is acceptable on `host`: loopback, the private IPv4
 * ranges, carrier-grade NAT (where Tailscale puts its addresses), and IPv6
 * loopback, unique-local and link-local addresses. An unspecified address
 * (`0.0.0.0`, `::`) listens everywhere, public interfaces included, and a host
 * name could resolve anywhere, so neither qualifies.
 */
const isPrivateHost = (host: string): boolean => {
  if (host === "localhost") return true;
  const octets = ipv4(host);
  if (octets !== undefined) {
    const [a = -1, b = -1] = octets;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = host.toLowerCase().replace(/^\[|\]$/g, "");
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
};

/** The nearest folder at or above `start` that holds a `.git` entry, if any. */
const enclosingCheckout = Effect.fn("enclosingCheckout")(function* (start: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let folder = start;
  while (true) {
    if (yield* fs.exists(path.join(folder, ".git"))) return Option.some(folder);
    const parent = path.dirname(folder);
    if (parent === folder) return Option.none();
    folder = parent;
  }
});

/**
 * Reads `J3_HOME`, `J3_HOST`, `J3_PORT`, `J3_TLS_CERT`, `J3_TLS_KEY`,
 * `J3_ENGINE_PORT` and `J3_ENGINE_BINARY`.
 */
export const layer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* environment;

    const home = path.resolve(
      Option.isSome(env.home)
        ? env.home.value
        : path.join(yield* Config.NonEmptyString("HOME"), ".j3-bots"),
    );
    // A home that does not exist yet is checked through its future parents.
    if (Option.isSome(yield* enclosingCheckout(home))) {
      return yield* new ConfigRefused({ setting: "J3_HOME", reason: "home-in-git-checkout" });
    }

    if (Option.isSome(env.tlsCert) !== Option.isSome(env.tlsKey)) {
      return yield* new ConfigRefused({ setting: "J3_TLS_CERT", reason: "tls-incomplete" });
    }
    const tls = Option.zipWith(env.tlsCert, env.tlsKey, (certPath, keyPath) => ({
      certPath: path.resolve(certPath),
      keyPath: path.resolve(keyPath),
    }));
    if (Option.isNone(tls) && !isPrivateHost(env.host)) {
      return yield* new ConfigRefused({ setting: "J3_HOST", reason: "public-address-without-tls" });
    }

    return {
      home,
      databasePath: path.join(home, "j3.sqlite"),
      host: env.host,
      port: env.port,
      tls,
      enginePort: env.enginePort,
      engineBinary: Option.map(env.engineBinary, (binary) => path.resolve(binary)),
    };
  }),
);
