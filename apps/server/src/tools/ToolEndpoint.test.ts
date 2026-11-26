// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type { BotId } from "@j3-bots/contracts";
import { SessionId, type TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { NO_TURN_REFUSAL } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Ports from "../system/Ports.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  createBot,
  engineSession,
  handoffs,
  nextTurn,
  sendToBot,
  teammateMessagesFor,
} from "../testing/turns.ts";
import * as BridgeKey from "./BridgeKey.ts";
import { bridgeSigner, SIGNATURE_HEADER, TOOL_CALL_PATH, ToolCallResponse } from "./protocol.ts";
import * as ToolEndpoint from "./ToolEndpoint.ts";

const endpoint = Ports.serve(ToolEndpoint.routes, NodeHttpServer.layerTest, {
  logAddress: false,
}).pipe(Layer.provideMerge(TestDomain.layer), Layer.provideMerge(BridgeKey.layer));

/** How a forward is signed: as the bridge signs it, not at all, or with a tag that is not its own. */
type Signed =
  | "bridge"
  | "unsigned"
  | { readonly tag: (body: string) => Effect.Effect<string, never, Mac.Mac> };

/** The bot is working on a message from the operator. */
const working = (name: string, text: string) =>
  Effect.gen(function* () {
    const bot = yield* createBot(name);
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, text);
    return { bot, session, turnId: yield* nextTurn(bot.id) };
  });

/** The arguments of an urgent message to `to`. */
const urgent = (to: BotId, text = "When is the launch?") => ({ to, text, urgent: true });

/** The engine records the bot's urgent message to `to` as an open call of its turn. */
const calls = (sessionId: SessionId, turnId: TurnId, to: BotId) =>
  Effect.gen(function* () {
    yield* (yield* TestEngineControl).toolCall({
      sessionId,
      turnId,
      tool: "message_bot",
      input: urgent(to),
      recorded: "now",
    });
  });

/** Ana's running turn has an open urgent message to Bo, which no request has claimed. */
const anaMessagesBo = Effect.gen(function* () {
  const bo = yield* createBot("Bo");
  const ana = yield* working("Ana", "Ask Bo for the launch date.");
  yield* calls(ana.session, ana.turnId, bo.id);
  return { ana, bo };
});

/** A `message_bot` call's forward, as the bridge writes it. */
const bodyOf = (call: {
  readonly requestId: string;
  readonly sessionId: SessionId;
  readonly arguments: object;
}) => JSON.stringify({ ...call, tool: "message_bot" });

interface Made {
  readonly host?: string;
  readonly origin?: string;
  readonly contentType?: string;
  readonly signed?: Signed;
}

/**
 * Posts a forward of a `message_bot` call to the endpoint, made the way the
 * bridge makes it unless `made` says otherwise. Answers the endpoint's
 * response, and whether it was signed for this request.
 */
const forward = (
  call: { readonly requestId: string; readonly sessionId: SessionId; readonly arguments: object },
  made: Made = {},
) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("The endpoint listens on TCP");
    const { signer } = yield* BridgeKey.BridgeKey;
    const body = bodyOf(call);
    const signed = made.signed ?? "bridge";
    const tag =
      signed === "bridge"
        ? yield* signer.signRequest(TOOL_CALL_PATH, body)
        : signed === "unsigned"
          ? undefined
          : yield* signed.tag(body).pipe(Effect.provide(mac));
    const request = HttpClientRequest.post(
      `http://127.0.0.1:${address.port}${TOOL_CALL_PATH}`,
    ).pipe(
      HttpClientRequest.setHeader("host", made.host ?? `127.0.0.1:${address.port}`),
      tag === undefined ? identity : HttpClientRequest.setHeader(SIGNATURE_HEADER, tag),
      HttpClientRequest.bodyText(body, made.contentType ?? "application/json"),
    );
    // Node's own client, which sends the `Host` it is given.
    const response = yield* HttpClient.execute(
      made.origin === undefined
        ? request
        : HttpClientRequest.setHeader(request, "origin", made.origin),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
    const text = yield* response.text;
    return {
      status: response.status,
      text,
      signedForIt:
        tag !== undefined &&
        (yield* signer.verifyAnswer(tag, text, response.headers[SIGNATURE_HEADER])),
    };
  });

const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));

/** The endpoint's answer to a forward it took, which it signed for that forward. */
const answer = (response: { readonly text: string; readonly signedForIt: boolean }) =>
  Effect.gen(function* () {
    assert.isTrue(response.signedForIt);
    return yield* decodeAnswer(response.text);
  });

const mac = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

const SENT = { _tag: "result", value: { status: "sent", note: "It wakes them now." } } as const;

/** No teammate message was recorded for Bo, and nothing wakes Bo. */
const boGotNothing = (anaId: BotId, boId: BotId) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* teammateMessagesFor(boId), { wakes: 0, held: 0 });
    assert.deepStrictEqual(yield* handoffs(anaId), []);
    assert.deepStrictEqual(yield* handoffs(boId), []);
  });

/** Bo got the message once, and one wake for it. */
const boGotItOnce = (anaId: BotId, boId: BotId) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* teammateMessagesFor(boId), { wakes: 1, held: 0 });
    assert.deepStrictEqual(yield* handoffs(anaId), ["sent: When is the launch?"]);
    assert.deepStrictEqual(yield* handoffs(boId), ["received: When is the launch?"]);
  });

/**
 * A request the bridge would not make is refused before it acts, and the call
 * it named is still there for the bridge's own request.
 */
const refusedThenTaken = (made: Made) =>
  Effect.gen(function* () {
    const { ana, bo } = yield* anaMessagesBo;
    const call = { sessionId: ana.session, arguments: urgent(bo.id) };

    const refused = yield* forward({ ...call, requestId: "call-1" }, made);
    assert.strictEqual(refused.status, 403);
    yield* boGotNothing(ana.bot.id, bo.id);

    const taken = yield* forward({ ...call, requestId: "call-2" });
    assert.deepStrictEqual(yield* answer(taken), SENT);
    yield* boGotItOnce(ana.bot.id, bo.id);
  });

it.effect("refuses a forward addressed to another host name", () =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("The endpoint listens on TCP");
    // A page on a name that resolves to loopback sends its own name.
    yield* refusedThenTaken({ host: `rebound.example:${address.port}` });
  }).pipe(Effect.provide(endpoint)),
);

it.effect("refuses a forward that carries an Origin", () =>
  refusedThenTaken({ origin: "https://page.example" }).pipe(Effect.provide(endpoint)),
);

it.effect("refuses a forward whose body is not declared JSON", () =>
  // What a page may send another origin without asking first.
  refusedThenTaken({ contentType: "text/plain" }).pipe(Effect.provide(endpoint)),
);

describe("a forward that knows the session's id", () => {
  it.effect("is refused with no signature", () =>
    refusedThenTaken({ signed: "unsigned" }).pipe(Effect.provide(endpoint)),
  );

  it.effect("is refused with the signature of another forward", () =>
    Effect.gen(function* () {
      const { signer } = yield* BridgeKey.BridgeKey;
      // A forward the bridge signed, whose tag is taken for other arguments.
      const other = bodyOf({ requestId: "call-0", sessionId: SessionId.make("x"), arguments: {} });
      yield* refusedThenTaken({ signed: { tag: () => signer.signRequest(TOOL_CALL_PATH, other) } });
    }).pipe(Effect.provide(endpoint)),
  );

  it.effect("is refused when signed with another key", () =>
    refusedThenTaken({
      signed: {
        // The forward as sent, signed with a key that is not the bridges'.
        tag: (body) =>
          Effect.gen(function* () {
            const key = yield* (yield* Mac.Mac).generateKey(Mac.hmacSha256).pipe(Effect.orDie);
            return yield* (yield* bridgeSigner(key)).signRequest(TOOL_CALL_PATH, body);
          }),
      },
    }).pipe(Effect.provide(endpoint)),
  );
});

it.effect("refuses a call named for a session whose turn has no such call open", () =>
  Effect.gen(function* () {
    const { ana, bo } = yield* anaMessagesBo;
    const bia = yield* working("Bia", "Check the build.");

    // Bia's session names the call Ana's turn has open.
    const borrowed = yield* forward({
      requestId: "call-1",
      sessionId: bia.session,
      arguments: urgent(bo.id),
    });
    assert.deepStrictEqual(yield* answer(borrowed), { _tag: "refused", message: NO_TURN_REFUSAL });
    yield* boGotNothing(ana.bot.id, bo.id);
    assert.deepStrictEqual(yield* handoffs(bia.bot.id), []);

    // The call is still Ana's.
    const own = yield* forward({
      requestId: "call-2",
      sessionId: ana.session,
      arguments: urgent(bo.id),
    });
    assert.deepStrictEqual(yield* answer(own), SENT);
    yield* boGotItOnce(ana.bot.id, bo.id);
  }).pipe(Effect.provide(endpoint)),
);

it.effect("refuses a request id another session's call already used", () =>
  Effect.gen(function* () {
    const { ana, bo } = yield* anaMessagesBo;
    // Bia's turn has the same call open.
    const bia = yield* working("Bia", "Ask Bo for the launch date too.");
    yield* calls(bia.session, bia.turnId, bo.id);
    const first = yield* forward({
      requestId: "call-1",
      sessionId: ana.session,
      arguments: urgent(bo.id),
    });
    assert.deepStrictEqual(yield* answer(first), SENT);

    // Bia's request takes the id of Ana's.
    const reused = yield* forward({
      requestId: "call-1",
      sessionId: bia.session,
      arguments: urgent(bo.id),
    });
    assert.deepStrictEqual(yield* answer(reused), { _tag: "refused", message: NO_TURN_REFUSAL });
    assert.deepStrictEqual(yield* handoffs(bia.bot.id), []);
    yield* boGotItOnce(ana.bot.id, bo.id);
  }).pipe(Effect.provide(endpoint)),
);

it.effect("answers a replayed request id with its first result, whatever it now carries", () =>
  Effect.gen(function* () {
    const { ana, bo } = yield* anaMessagesBo;
    const first = yield* forward({
      requestId: "call-1",
      sessionId: ana.session,
      arguments: urgent(bo.id),
    });
    assert.deepStrictEqual(yield* answer(first), SENT);

    const replayed = yield* forward({
      requestId: "call-1",
      sessionId: ana.session,
      arguments: urgent(bo.id, "Ship it today."),
    });
    assert.deepStrictEqual(yield* answer(replayed), SENT);
    yield* boGotItOnce(ana.bot.id, bo.id);
  }).pipe(Effect.provide(endpoint)),
);
