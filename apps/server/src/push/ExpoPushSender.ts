// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  type PushMessage,
  type PushReceipt,
  PushReceiptId,
  PushRejected,
  PushSender,
  PushUnavailable,
  PushUnregistered,
} from "./PushSender.ts";

// Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/).
// It takes messages with no credential while the project leaves "enhanced
// security" off, which a self-hosted server must: it cannot hold the project's
// access token.

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** The most receipt ids Expo answers in one request. */
const RECEIPTS_PER_REQUEST = 1000;

/** How long one request may take before it counts as unanswered. */
const REQUEST_TIMEOUT = Duration.seconds(30);

/**
 * How long Apple's and Google's services hold a notification for a device
 * that is offline. A day: a notification about something older is noise, and
 * the roster shows it unread.
 */
const TIME_TO_LIVE_SECONDS = 24 * 60 * 60;

/** Why Expo refused a message or a request, when it says. */
const ErrorDetails = Schema.optional(Schema.Struct({ error: Schema.optional(Schema.String) }));

const Ticket = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), id: PushReceiptId }),
  Schema.Struct({ status: Schema.Literal("error"), details: ErrorDetails }),
]);

const SendResponse = Schema.Struct({ data: Schema.Tuple([Ticket]) });

const Receipt = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("error"), details: ErrorDetails }),
]);

const ReceiptsResponse = Schema.Struct({ data: Schema.Record(Schema.String, Receipt) });

/** What a request that failed as a whole says about itself. */
const RequestErrors = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ code: Schema.String })),
});

/**
 * Expo's error code, never its message: a message can quote the push token,
 * which is kept out of the logs.
 */
const codeOf = (details: typeof ErrorDetails.Type): string => details?.error ?? "unknown";

/**
 * The message as Expo takes it. A send that may be repeated replaces, rather
 * than adds to, a notification already shown: on Android by its `tag`, on iOS
 * by its `collapseId`. Android's `collapseId` is left out: Google keeps only
 * four of them per device while it is offline, and drops the rest.
 */
const expoMessage = (message: PushMessage) => ({
  to: message.token,
  title: message.title,
  body: message.body,
  data: message.data,
  ttl: TIME_TO_LIVE_SECONDS,
  priority: "high",
  sound: "default",
  ...(message.platform === "android" ? { tag: message.key } : { collapseId: message.key }),
});

/**
 * Posts a request and reads its answer. Network failures, timeouts, 429 and
 * 5xx may pass if tried again; any other refusal of the whole request will
 * not. An answer that cannot be read is treated as one that may pass later.
 */
const post = <A>(
  client: HttpClient.HttpClient,
  url: string,
  body: unknown,
  answer: Schema.Codec<A, unknown>,
): Effect.Effect<A, PushUnavailable | PushRejected> =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJson(body),
    );
    const response = yield* client.execute(request);
    if (response.status === 429 || response.status >= 500) {
      return yield* new PushUnavailable({ reason: `HTTP ${response.status}` });
    }
    if (response.status !== 200) {
      const code = yield* HttpClientResponse.schemaBodyJson(RequestErrors)(response).pipe(
        Effect.map(({ errors }) => errors[0]?.code ?? "unknown"),
        Effect.orElseSucceed(() => "unknown"),
      );
      return yield* new PushRejected({ reason: `HTTP ${response.status}: ${code}` });
    }
    return yield* HttpClientResponse.schemaBodyJson(answer)(response);
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new PushUnavailable({ reason: "timed out" })),
    }),
    Effect.catchTags({
      HttpBodyError: () => Effect.die("A push message encodes as JSON"),
      HttpClientError: (error) =>
        Effect.fail(new PushUnavailable({ reason: `request failed: ${error.reason._tag}` })),
      SchemaError: () => Effect.fail(new PushUnavailable({ reason: "unreadable answer" })),
    }),
  );

export const layer = Layer.effect(
  PushSender,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const send = Effect.fn("ExpoPushSender.send")(function* (message: PushMessage) {
      const {
        data: [ticket],
      } = yield* post(client, SEND_URL, [expoMessage(message)], SendResponse);
      if (ticket.status === "ok") return ticket.id;
      const code = codeOf(ticket.details);
      if (code === "DeviceNotRegistered") return yield* new PushUnregistered();
      return yield* new PushRejected({ reason: code });
    });

    const receipts = Effect.fn("ExpoPushSender.receipts")(function* (
      ids: ReadonlyArray<PushReceiptId>,
    ) {
      const found = new Map<PushReceiptId, PushReceipt>();
      for (let start = 0; start < ids.length; start += RECEIPTS_PER_REQUEST) {
        const chunk = ids.slice(start, start + RECEIPTS_PER_REQUEST);
        const { data } = yield* post(client, RECEIPTS_URL, { ids: chunk }, ReceiptsResponse).pipe(
          // A request's own refusal is no answer about any message in it.
          Effect.catchTag("PushRejected", (rejected) =>
            Effect.fail(new PushUnavailable({ reason: rejected.reason })),
          ),
        );
        for (const id of chunk) {
          const receipt = data[id];
          if (receipt === undefined) continue;
          if (receipt.status === "ok") {
            found.set(id, { _tag: "delivered" });
            continue;
          }
          const code = codeOf(receipt.details);
          found.set(
            id,
            code === "DeviceNotRegistered"
              ? { _tag: "unregistered" }
              : { _tag: "rejected", reason: code },
          );
        }
      }
      return found;
    });

    return PushSender.of({ send, receipts });
  }),
);
