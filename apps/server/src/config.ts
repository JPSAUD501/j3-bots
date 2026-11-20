// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Installation from "./installation.ts";
import { isWithin, realLocation } from "./paths.ts";
import { isPrivateAddress, Network } from "./system/Network.ts";
import * as TlsCredentials from "./system/Tls.ts";

/** Where the web client the server serves comes from. */
type WebClientSource =
  /** Set in `webClient` or `J3_WEB_CLIENT`: it must hold a built client. */
  | { readonly _tag: "configured"; readonly directory: string }
  /** The client built in this checkout, served once it is built. */
  | { readonly _tag: "bundled"; readonly directory: string };

export interface ServerConfigShape {
  /**
   * Where J3 Bots keeps its state: the configuration file, the database, the
   * bot workspaces and the engine's own data directory. Never inside a Git
   * checkout, or the engine treats every bot workspace as part of that repository.
   */
  readonly home: string;
  /** `<home>/config.json`. */
  readonly configFile: string;
  readonly databasePath: string;
  /** The engine's data directory, `<home>/engine`. */
  readonly engineHome: string;
  /**
   * The address the server listens on. `0.0.0.0` when the setting is `lan`:
   * every IPv4 interface, which start refuses unless all of them are private.
   */
  readonly host: string;
  readonly port: number;
  /** A certificate and key to serve HTTPS with. Required on a public address. */
  readonly tls: Option.Option<{ readonly certPath: string; readonly keyPath: string }>;
  /** The loopback port the engine listens on. */
  readonly enginePort: number;
  /** An engine executable to use instead of the pinned one J3 Bots installs. */
  readonly engineBinary: Option.Option<string>;
  /**
   * The loopback port of the bot tool endpoint, which the `j3` bridge forwards
   * tool calls to. Always bound to loopback, whatever `host` is.
   */
  readonly toolPort: number;
  /** The built web client, served on the same origin as the API. */
  readonly webClient: WebClientSource;
  /**
   * The admin socket, `<home>/admin.sock`: how `j3-bots` commands reach the
   * running server. A Unix socket, so only the operator's user can connect.
   */
  readonly adminSocket: string;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@j3-bots/server/config/ServerConfig",
) {}

/** The configuration names a setting J3 Bots will not run with. */
class ConfigRefused extends Schema.TaggedError<ConfigRefused>()("ConfigRefused", {
  setting: Schema.String,
  reason: Schema.Literals([
    "home-in-git-checkout",
    "home-path-too-long",
    "public-address-without-tls",
    "lan-has-public-address",
    "tls-incomplete",
    "tls-unusable",
    "web-client-missing",
    "web-client-holds-state",
    "port-zero",
    "port-conflict",
  ]),
  /** The address, path or value the reason is about. */
  subject: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "home-in-git-checkout":
        return `${this.setting} (${this.subject}) is inside a Git checkout. Choose a folder outside any repository.`;
      case "home-path-too-long":
        return `${this.setting} (${this.subject}) is too long a path for the admin socket inside it. Choose a shorter one.`;
      case "public-address-without-tls":
        return `${this.setting} (${this.subject}) is not a loopback or private IP address. Use one of this machine's private addresses, written as an IP address, or set a TLS certificate and key to serve it over HTTPS.`;
      case "lan-has-public-address":
        return `${this.setting} is "lan", but this machine has the public address ${this.subject}, which "lan" would also serve. Set it to one private address of this machine, or set a TLS certificate and key.`;
      case "tls-incomplete":
        return `${this.setting}: a TLS certificate and key must be set together.`;
      case "tls-unusable":
        return `${this.setting}: ${this.subject}`;
      case "web-client-missing":
        return `${this.setting} (${this.subject}) holds no built web client (no index.html). Build it, or remove the setting to use the one in this checkout.`;
      case "web-client-holds-state":
        return `${this.setting} is a folder that holds ${this.subject}, which the server would then publish. Point it at the built client's own folder.`;
      case "port-zero":
        return `${this.setting} is 0, but this port is dialed at the number set here. Choose a fixed free port.`;
      case "port-conflict":
        return `${this.setting} share port ${this.subject}. Give each its own port.`;
    }
  }
}

/** The configuration file exists but cannot be used as it is. */
class ConfigFileInvalid extends Schema.TaggedError<ConfigFileInvalid>()("ConfigFileInvalid", {
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.path} is not valid: ${this.detail}\nFix it, or delete it to have the server write the defaults again.`;
  }
}

const CONFIG_FILE = "config.json";
const ADMIN_SOCKET = "admin.sock";
/** The shortest `sun_path` among supported systems is 104 bytes, its terminator included. */
const MAX_SOCKET_PATH_BYTES = 103;

/** The `host` value that listens on every IPv4 interface, if all of them are private. */
const LAN = "lan";
const LAN_ADDRESS = "0.0.0.0";

const Tls = Schema.Struct({ cert: Schema.NonEmptyString, key: Schema.NonEmptyString });

/**
 * `<J3_HOME>/config.json`. Every setting is optional; a missing one takes its
 * default. Unknown keys are refused, so a misspelt setting is never ignored.
 */
const ConfigFile = Schema.Struct({
  host: Schema.optionalKey(Schema.NonEmptyString),
  port: Schema.optionalKey(Schema.Port),
  toolPort: Schema.optionalKey(Schema.Port),
  enginePort: Schema.optionalKey(Schema.Port),
  webClient: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  tls: Schema.optionalKey(Schema.NullOr(Tls)),
});
type ConfigFile = typeof ConfigFile.Type;

/** What a new `config.json` holds: every setting, at its default, for the operator to edit. */
export const DEFAULTS = {
  host: LAN,
  port: 3737,
  toolPort: 3739,
  enginePort: 3738,
  webClient: null,
  tls: null,
} satisfies Required<ConfigFile>;

const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile));
const encodeDefaults = Schema.encodeSync(Schema.fromJsonString(ConfigFile, { space: 2 }));

/**
 * The variables that override a setting of the file. A service does not
 * inherit them from the shell that installs it: it runs with the file.
 * `J3_ENGINE_BINARY` has no setting in the file; it is for testing an engine
 * build, and a service never uses it.
 */
export const SHELL_OVERRIDES = [
  "J3_HOST",
  "J3_PORT",
  "J3_TOOL_PORT",
  "J3_ENGINE_PORT",
  "J3_WEB_CLIENT",
  "J3_TLS_CERT",
  "J3_TLS_KEY",
  "J3_ENGINE_BINARY",
] as const;

/** What an operator should know about an override set in their shell, once a service runs. */
export const overrideNote = (name: (typeof SHELL_OVERRIDES)[number], configFile: string) =>
  name === "J3_ENGINE_BINARY"
    ? "J3_ENGINE_BINARY is set in this shell. It is for testing an engine build, and the service never uses it: it runs the pinned engine."
    : `${name} is set in this shell, but the service does not get it. Put the setting in ${configFile} instead.`;

/** The overrides set in this process's environment. */
export const shellOverrides = Effect.gen(function* () {
  const set: Array<(typeof SHELL_OVERRIDES)[number]> = [];
  for (const name of SHELL_OVERRIDES) {
    if (Option.isSome(yield* Config.option(Config.String(name)))) set.push(name);
  }
  return set;
});

// A setting in the environment overrides the file. One that is present and
// invalid fails, so a typo never silently becomes the default.
const environment = Config.all({
  home: Config.option(Config.NonEmptyString("J3_HOME")),
  host: Config.option(Config.NonEmptyString("J3_HOST")),
  port: Config.option(Config.Port("J3_PORT")),
  tlsCert: Config.option(Config.NonEmptyString("J3_TLS_CERT")),
  tlsKey: Config.option(Config.NonEmptyString("J3_TLS_KEY")),
  enginePort: Config.option(Config.Port("J3_ENGINE_PORT")),
  engineBinary: Config.option(Config.NonEmptyString("J3_ENGINE_BINARY")),
  toolPort: Config.option(Config.Port("J3_TOOL_PORT")),
  webClient: Config.option(Config.NonEmptyString("J3_WEB_CLIENT")),
});

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

/** `J3_HOME`, or `~/.j3-bots`, as an absolute path. */
export const resolveHome = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* Config.option(Config.NonEmptyString("J3_HOME"));
  return path.resolve(
    Option.isSome(home) ? home.value : path.join(yield* Config.NonEmptyString("HOME"), ".j3-bots"),
  );
});

/**
 * The running server's admin socket, `<home>/admin.sock`. It depends on the
 * home alone, so commands find the server even when this shell's other
 * settings differ from the ones it runs with.
 */
export const resolveAdminSocket = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* resolveHome, ADMIN_SOCKET);
});

/** The settings in `<home>/config.json`; none when the file does not exist. */
const readConfigFile = Effect.fn("readConfigFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return {} satisfies ConfigFile;
  const text = yield* fs.readFileString(file);
  return yield* decodeConfigFile(text, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ConfigFileInvalid({ path: file, detail: error.message })),
  );
});

/**
 * The server's configuration: `J3_HOME` from the environment, every other
 * setting from the environment, else from `<home>/config.json`, else its
 * default. Reads only; `layer` also creates the home and the file.
 */
export const load = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* environment;
  const home = yield* resolveHome;
  const configFile = path.join(home, CONFIG_FILE);
  const file = yield* readConfigFile(configFile);
  const fileSetting = (name: keyof ConfigFile) => `${name} in ${configFile}`;

  // A home that does not exist yet is checked through its future parents.
  if (Option.isSome(yield* enclosingCheckout(home))) {
    return yield* new ConfigRefused({
      setting: "J3_HOME",
      reason: "home-in-git-checkout",
      subject: home,
    });
  }
  const adminSocket = path.join(home, ADMIN_SOCKET);
  if (new TextEncoder().encode(adminSocket).length > MAX_SOCKET_PATH_BYTES) {
    return yield* new ConfigRefused({
      setting: "J3_HOME",
      reason: "home-path-too-long",
      subject: home,
    });
  }

  // TLS from the environment replaces the file's as a pair.
  if (Option.isSome(env.tlsCert) !== Option.isSome(env.tlsKey)) {
    return yield* new ConfigRefused({
      setting: "J3_TLS_CERT and J3_TLS_KEY",
      reason: "tls-incomplete",
      subject: "",
    });
  }
  const tls = Option.orElse(
    Option.zipWith(env.tlsCert, env.tlsKey, (certPath, keyPath) => ({ certPath, keyPath })),
    () =>
      Option.map(Option.fromNullishOr(file.tls), ({ cert, key }) => ({
        certPath: cert,
        keyPath: key,
      })),
  ).pipe(
    Option.map(({ certPath, keyPath }) => ({
      certPath: path.resolve(home, certPath),
      keyPath: path.resolve(home, keyPath),
    })),
  );

  if (Option.isSome(tls)) {
    const loaded = yield* TlsCredentials.load(tls.value).pipe(Effect.result);
    if (loaded._tag === "Failure") {
      return yield* new ConfigRefused({
        setting: Option.isSome(env.tlsCert) ? "J3_TLS_CERT and J3_TLS_KEY" : fileSetting("tls"),
        reason: "tls-unusable",
        subject: loaded.failure.message,
      });
    }
  }

  const ports = {
    port: Option.getOrElse(env.port, () => file.port ?? DEFAULTS.port),
    toolPort: Option.getOrElse(env.toolPort, () => file.toolPort ?? DEFAULTS.toolPort),
    enginePort: Option.getOrElse(env.enginePort, () => file.enginePort ?? DEFAULTS.enginePort),
  };
  const portSetting = (name: keyof typeof ports, variable: string) =>
    Option.isSome(env[name]) ? variable : file[name] !== undefined ? fileSetting(name) : name;
  const portSettings = {
    port: portSetting("port", "J3_PORT"),
    toolPort: portSetting("toolPort", "J3_TOOL_PORT"),
    enginePort: portSetting("enginePort", "J3_ENGINE_PORT"),
  };
  // The bridge dials the tool endpoint, and the adapter the engine, at the
  // number configured: neither can take one the system picks.
  for (const name of ["toolPort", "enginePort"] as const) {
    if (ports[name] === 0) {
      return yield* new ConfigRefused({
        setting: portSettings[name],
        reason: "port-zero",
        subject: "0",
      });
    }
  }
  const names = ["port", "toolPort", "enginePort"] as const;
  for (const [index, first] of names.entries()) {
    for (const second of names.slice(index + 1)) {
      if (ports[first] !== 0 && ports[first] === ports[second]) {
        return yield* new ConfigRefused({
          setting: `${portSettings[first]} and ${portSettings[second]}`,
          reason: "port-conflict",
          subject: String(ports[first]),
        });
      }
    }
  }

  const hostSetting = Option.isSome(env.host)
    ? "J3_HOST"
    : file.host !== undefined
      ? fileSetting("host")
      : "host";
  const hostValue = Option.getOrElse(env.host, () => file.host ?? DEFAULTS.host);
  if (Option.isNone(tls)) {
    if (hostValue === LAN) {
      const network = yield* Network;
      const exposed = (yield* network.ipv4Addresses).find(
        ({ address, internal }) => !internal && !isPrivateAddress(address),
      );
      if (exposed !== undefined) {
        return yield* new ConfigRefused({
          setting: hostSetting,
          reason: "lan-has-public-address",
          subject: exposed.address,
        });
      }
    } else if (!isPrivateAddress(hostValue)) {
      return yield* new ConfigRefused({
        setting: hostSetting,
        reason: "public-address-without-tls",
        subject: hostValue,
      });
    }
  }
  const configuredWebClient = Option.orElse(env.webClient, () =>
    Option.fromNullishOr(file.webClient),
  );
  const webClientSetting = Option.isSome(env.webClient)
    ? "J3_WEB_CLIENT"
    : fileSetting("webClient");
  let webClient: WebClientSource;
  if (Option.isSome(configuredWebClient)) {
    const directory = path.resolve(home, configuredWebClient.value);
    if (!(yield* fs.exists(path.join(directory, "index.html")))) {
      return yield* new ConfigRefused({
        setting: webClientSetting,
        reason: "web-client-missing",
        subject: directory,
      });
    }
    webClient = { _tag: "configured", directory };
  } else {
    webClient = { _tag: "bundled", directory: yield* Installation.bundledWebClient };
  }
  // Everything under the client's folder is public: it must hold no state.
  const webRoot = yield* realLocation(webClient.directory);
  const state = [
    home,
    ...Option.match(tls, {
      onNone: () => [],
      onSome: ({ certPath, keyPath }) => [certPath, keyPath],
    }),
  ];
  for (const held of state) {
    if (isWithin(webRoot, yield* realLocation(held))) {
      return yield* new ConfigRefused({
        setting:
          webClient._tag === "configured"
            ? webClientSetting
            : `The web client in this checkout (${webClient.directory})`,
        reason: "web-client-holds-state",
        subject: held,
      });
    }
  }

  return {
    home,
    configFile,
    databasePath: path.join(home, "j3.sqlite"),
    engineHome: path.join(home, "engine"),
    host: hostValue === LAN ? LAN_ADDRESS : hostValue,
    port: ports.port,
    tls,
    enginePort: ports.enginePort,
    engineBinary: Option.map(env.engineBinary, (binary) => path.resolve(binary)),
    toolPort: ports.toolPort,
    webClient,
    adminSocket,
  } satisfies ServerConfigShape;
});

/**
 * Creates the home (readable by the operator only) and, on first run, a
 * `config.json` holding every setting at its default. An existing file is
 * never rewritten.
 */
export const initializeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveHome;
  if (Option.isSome(yield* enclosingCheckout(home))) {
    return yield* new ConfigRefused({
      setting: "J3_HOME",
      reason: "home-in-git-checkout",
      subject: home,
    });
  }
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
  yield* fs
    .writeFileString(path.join(home, CONFIG_FILE), `${encodeDefaults(DEFAULTS)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
});

/** The configuration for a server about to start: creates its home, then loads. */
export const layer = Layer.effect(ServerConfig, Effect.andThen(initializeHome, load));
