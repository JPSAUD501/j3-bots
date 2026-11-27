// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_SESSION_LIMITS, type SessionLimits } from "@j3-bots/connectors";
import { type FakeMcpServer, type FakeOptions, fakeMcpServer } from "@j3-bots/connectors/testing";
import { type BotId, CommandId, ConnectorId, type Connector } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ConnectorReach, Connectors, MAX_SESSIONS } from "../connectors/Connectors.ts";
import { connectorSecretIdOf } from "../connectors/credentials.ts";
import { Secrets } from "../secrets/Secrets.ts";

/**
 * Connectors through the server's own connectors service, each to a fake MCP
 * server on loopback.
 *
 * The fake answers over plain HTTP on loopback, which no address an operator
 * adds can name. So the service may reach loopback here and resolves no name,
 * so a connector's first listing, at its address, fails; its sealed address
 * is then pointed at the fake, which the next listing reaches. At most
 * `sessions` remote sessions are open at once.
 */
export const reachFakesWith = (sessions: number) =>
  Layer.succeed(ConnectorReach, {
    limits: {
      ...DEFAULT_SESSION_LIMITS,
      guard: {
        ...DEFAULT_SESSION_LIMITS.guard,
        resolve: () => Promise.reject(new Error("no such host")),
      },
    } satisfies SessionLimits,
    loopback: "allow-http",
    sessions,
  });

/** As {@link reachFakesWith}, with as many sessions open at once as the server keeps. */
export const reachFakes = reachFakesWith(MAX_SESSIONS);

/** A call that reached a fake connector's server. */
interface FakeCall {
  readonly name: string;
  readonly arguments: unknown;
}

interface FakeConnector {
  readonly fake: FakeMcpServer;
  /** The connector is the tool of these bots alone, once its tools are listed for each. */
  readonly grant: (bots: ReadonlyArray<BotId>) => Effect.Effect<void>;
  /** Every call that reached its server, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<FakeCall>>;
}

/**
 * A connector named `name` to a fake server listing `tools`, granted to no
 * bot. Each call answers with the tool's name, unless `answer` says otherwise.
 * Its id comes from its name, so a test's connectors have names of their own.
 */
export const fakeConnector = Effect.fn("TestConnectors.fakeConnector")(function* (input: {
  readonly name: string;
  readonly tools: FakeOptions["tools"];
  readonly answer?: FakeOptions["call"];
  /** What its server answers `resources/read` with, as the fake's own option. */
  readonly resources?: FakeOptions["resources"];
  /** The skills its server serves, as the fake's own option. */
  readonly skills?: FakeOptions["skills"];
}) {
  const calls: Array<FakeCall> = [];
  const fake = yield* fakeMcpServer({
    tools: input.tools,
    call: (name, args, headers) => {
      calls.push({ name, arguments: args });
      return input.answer?.(name, args, headers) ?? { _tag: "result", text: `${name} answered` };
    },
    ...(input.resources === undefined ? {} : { resources: input.resources }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
  });
  const secrets = yield* Secrets;
  const service = yield* Connectors;
  const id = ConnectorId.make(`conn_${input.name.toLowerCase().padEnd(16, "0")}`);
  yield* service.add({
    id,
    source: {
      _tag: "remote",
      name: input.name,
      url: Redacted.make(`https://${input.name.toLowerCase()}.example/mcp`),
      headers: [],
      oauthClient: null,
      privateNetwork: false,
    },
    grant: { _tag: "bots", ids: [] },
    by: { _tag: "operator" },
  });
  const secret = yield* secrets.connectorSecrets.get(connectorSecretIdOf(id));
  if (Option.isNone(secret)) return yield* Effect.die("The connector's secret was not sealed");
  yield* secrets.connectorSecrets.put({ ...secret.value, address: Redacted.make(fake.url) });

  const listedFor = (bot: BotId) =>
    Effect.gen(function* () {
      // Asking for a bot's tools lists a connector its server has not listed yet.
      yield* service.toolsFor(bot);
      yield* service.subscribe.pipe(
        Stream.flatMap((event) =>
          Stream.fromIterable(event._tag === "snapshot" ? event.connectors : event.upsert),
        ),
        Stream.filter(
          (connector: Connector) =>
            connector.id === id &&
            connector.status._tag === "connected" &&
            connector.tools.length > 0 &&
            // What its server serves is listed after its tools.
            (input.skills === undefined || connector.skills !== undefined),
        ),
        Stream.runHead,
      );
    });

  return {
    fake,
    grant: (bots) =>
      Effect.gen(function* () {
        yield* service.setBots({
          commandId: CommandId.make(`grant-${id}-${bots.join(",")}`),
          connectorId: id,
          grant: { _tag: "bots", ids: bots },
          by: { _tag: "operator" },
        });
        yield* Effect.forEach(bots, listedFor, { discard: true });
      }).pipe(Effect.orDie),
    calls: Effect.sync(() => [...calls]),
  } satisfies FakeConnector;
}, Effect.orDie);
