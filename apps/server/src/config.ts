import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export interface ServerConfigShape {
  /**
   * Where J3 Bots keeps its state: the database, the bot workspaces and the
   * engine's own data directory. Must not sit inside a Git checkout, or the
   * engine treats every bot workspace as part of that repository.
   */
  readonly home: string;
  readonly databasePath: string;
  /** Loopback by default. Anything wider is the operator's choice. */
  readonly host: string;
  readonly port: number;
  /** An engine executable to use instead of the pinned one J3 Bots installs. */
  readonly engineBinary: Option.Option<string>;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@j3-bots/server/config/ServerConfig",
) {}

const DEFAULT_PORT = 3737;

const environment = Config.all({
  home: Config.NonEmptyString("J3_HOME").pipe(
    Config.orElse(() =>
      Config.NonEmptyString("HOME").pipe(Config.map((userHome) => `${userHome}/.j3-bots`)),
    ),
  ),
  host: Config.NonEmptyString("J3_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("J3_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  engineBinary: Config.option(Config.NonEmptyString("J3_ENGINE_BINARY")),
});

/** Reads `J3_HOME`, `J3_HOST`, `J3_PORT` and `J3_ENGINE_BINARY`. */
export const layer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* environment;
    const home = path.resolve(env.home);
    return {
      home,
      databasePath: path.join(home, "j3.sqlite"),
      host: env.host,
      port: env.port,
      engineBinary: Option.map(env.engineBinary, (binary) => path.resolve(binary)),
    };
  }),
);
