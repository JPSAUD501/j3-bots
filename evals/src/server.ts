// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type AttachmentId,
  type DeviceToken,
  HTTP_PATHS,
  J3Rpcs,
  PairingCode,
  PairResult,
  PairRequest,
  type ProviderStatus,
  ServerInfo,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

/** A step of booting or driving the server that did not go as it must. */
export class EvalFailure extends Schema.TaggedError<EvalFailure>()("EvalFailure", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Where one run's server lives and listens. */
export interface ServerSpec {
  /** The checkout whose server runs, from source. */
  readonly repo: string;
  /** The run's `J3_HOME`, a fresh folder. */
  readonly home: string;
  /** The server's port; the engine and the bot tools take the next two. */
  readonly port: number;
  /** An engine executable an earlier run installed, so this run downloads none. */
  readonly engineBinary: Option.Option<string>;
}

/**
 * The environment the server and its CLI run with: only what a process needs
 * to run as this user, plus the run's configuration. Nothing else of the
 * caller's environment reaches it, the endpoint's key least of all.
 */
const environment = (spec: ServerSpec): Record<string, string> => {
  const passed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR"];
  const own: Record<string, string> = {};
  for (const name of passed) {
    const value = process.env[name];
    if (value !== undefined) own[name] = value;
  }
  return {
    ...own,
    J3_HOME: spec.home,
    J3_HOST: "127.0.0.1",
    J3_PORT: String(spec.port),
    J3_ENGINE_PORT: String(spec.port + 1),
    J3_TOOL_PORT: String(spec.port + 2),
    ...Option.match(spec.engineBinary, {
      onNone: () => ({}),
      onSome: (binary) => ({ J3_ENGINE_BINARY: binary }),
    }),
  };
};

/** The server's CLI with `args`, from source, as the run's server sees itself. */
const serverCommand = Effect.fn("serverCommand")(function* (
  spec: ServerSpec,
  args: ReadonlyArray<string>,
  options: Pick<ChildProcess.CommandOptions, "stdin" | "forceKillAfter"> = {},
) {
  const path = yield* Path.Path;
  const entry = path.join(spec.repo, "apps", "server", "src", "bin.ts");
  return ChildProcess.make(process.execPath, [entry, ...args], {
    env: environment(spec),
    extendEnv: false,
    stdin: "ignore",
    killSignal: "SIGTERM",
    forceKillAfter: "5 seconds",
    ...options,
  });
});

/** Runs a `j3-bots` command against the run's server: its exit code and what it printed. */
const cli = Effect.fn("cli")(function* (
  spec: ServerSpec,
  args: ReadonlyArray<string>,
  input: Option.Option<Redacted.Redacted<string>> = Option.none(),
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* serverCommand(spec, args, {
    stdin: Option.match(input, {
      onNone: () => "ignore",
      onSome: (text) => Stream.make(new TextEncoder().encode(Redacted.value(text))),
    }),
  });
  const run = Effect.gen(function* () {
    const handle = yield* spawner.spawn(command);
    const [output, exitCode] = yield* Effect.all(
      [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { output, exitCode: Number(exitCode) };
  });
  return yield* Effect.scoped(run).pipe(
    Effect.mapError((cause) => new EvalFailure({ reason: `j3-bots ${args[0]}: ${cause.message}` })),
  );
});

const origin = (spec: ServerSpec) => `http://127.0.0.1:${spec.port}`;

/**
 * Starts the server for the scope, its output in `log`, and waits until it
 * answers. Closing the scope stops it, and it stops the engine.
 *
 * Only a server that started after this one was spawned counts as answering,
 * and this one exiting first fails the run: a server left on the port from
 * elsewhere is never taken for it.
 */
export const startServer = Effect.fn("startServer")(function* (spec: ServerSpec, log: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  // The server's own budget for a stop is about 17 seconds.
  const command = yield* serverCommand(spec, ["serve"], { forceKillAfter: "30 seconds" });
  const spawnedAt = yield* DateTime.now;
  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError((cause) => new EvalFailure({ reason: cause.message })));
  yield* handle.all.pipe(Stream.run(fs.sink(log)), Effect.ignore, Effect.forkScoped);
  const answered = http.get(`${origin(spec)}${HTTP_PATHS.server}`).pipe(
    Effect.filterOrFail((response) => response.status === 200),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ServerInfo)),
    Effect.filterOrFail((info) => DateTime.isGreaterThanOrEqualTo(info.startedAt, spawnedAt)),
    Effect.retry(Schedule.spaced("500 millis")),
  );
  const exited = handle.exitCode.pipe(
    Effect.mapError((cause) => new EvalFailure({ reason: cause.message })),
    Effect.flatMap((code) =>
      Effect.fail(
        new EvalFailure({ reason: `The server exited with code ${code} before it answered` }),
      ),
    ),
  );
  yield* Effect.raceFirst(answered, exited);
});

/** The last `count` lines the run's server wrote, none if its log cannot be read. */
export const logTail = (log: string, count: number) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(log)),
    Effect.map((text) => text.trimEnd().split("\n").slice(-count)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/**
 * Connects the run's providers to the endpoint, as `j3-bots provider connect`
 * does: the key goes in on standard input, never on the command line.
 */
export const connectProviders = Effect.fn("connectProviders")(function* (
  spec: ServerSpec,
  endpoint: { readonly baseUrl: string; readonly key: Redacted.Redacted<string> },
) {
  const { output, exitCode } = yield* cli(
    spec,
    ["provider", "connect", "--base-url", endpoint.baseUrl, "--yes"],
    Option.some(endpoint.key),
  );
  if (exitCode !== 0) {
    return yield* new EvalFailure({ reason: `provider connect failed: ${output.trim()}` });
  }
});

const PRINTED_CODE = /Pairing code: ([0-9A-Z]{5})-([0-9A-Z]{5})/;

/** Pairs the eval as a device, as a client does with the code `j3-bots pair` prints. */
export const pair = Effect.fn("pair")(function* (spec: ServerSpec) {
  const http = yield* HttpClient.HttpClient;
  const { output, exitCode } = yield* cli(spec, ["pair"]);
  const printed = PRINTED_CODE.exec(output);
  if (exitCode !== 0 || printed === null) {
    return yield* new EvalFailure({ reason: `pair failed: ${output.trim()}` });
  }
  const code = yield* Schema.decodeEffect(PairingCode)(`${printed[1]}${printed[2]}`);
  return yield* HttpClientRequest.post(`${origin(spec)}${HTTP_PATHS.pair}`).pipe(
    HttpClientRequest.schemaBodyJson(PairRequest)({ code, name: "Room eval" }),
    Effect.flatMap(http.execute),
    Effect.filterOrFail((response) => response.status === 200),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(PairResult)),
    Effect.mapError(() => new EvalFailure({ reason: "The server refused the pairing code" })),
  );
});

/** An RPC client of the run's server, as the device `token` was paired, for the scope. */
export const connectClient = Effect.fn("connectClient")(function* (
  spec: ServerSpec,
  token: DeviceToken,
) {
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        NodeSocket.layerWebSocket(`ws://127.0.0.1:${spec.port}${HTTP_PATHS.rpc}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(J3Rpcs).pipe(Effect.provide(protocol));
});

export type Client = Effect.Success<ReturnType<typeof connectClient>>;

/** The text of a file in the run's server, fetched as a client fetches an attachment. */
export const download = Effect.fn("download")(function* (
  spec: ServerSpec,
  token: DeviceToken,
  id: AttachmentId,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get(`${origin(spec)}${HTTP_PATHS.attachments}/${id}`).pipe(
      HttpClientRequest.bearerToken(token),
    ),
  );
  if (response.status !== 200) {
    return yield* new EvalFailure({ reason: `The server answered ${response.status} for ${id}` });
  }
  return yield* response.text;
});

/** The Claude Code provider, if the engine is ready and reports it ready with models. */
const readyClaudeCode = (providers: ReadonlyArray<ProviderStatus>) =>
  Option.fromNullishOr(
    providers.find(
      (provider) =>
        provider.harness === "claude-code" &&
        provider.status._tag === "ready" &&
        provider.models.length > 0,
    ),
  );

/** The Claude Code provider, once the engine reports it ready with its models. */
export const claudeCode = (client: Client) =>
  client["engine.subscribe"]().pipe(
    Stream.map((status) =>
      status.state._tag === "ready" ? readyClaudeCode(status.providers) : Option.none(),
    ),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new EvalFailure({ reason: "The engine stopped reporting" })),
        onSome: Effect.succeed,
      }),
    ),
  );
