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
  PushThrottled,
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

/**
 * The error codes Expo documents for one message, in its ticket or its
 * receipt. Any other code is logged as undocumented: what Expo sends is never
 * logged as it came, since its text could quote a push token.
 */
const MessageError = Schema.Literals([
  "DeviceNotRegistered",
  "MessageTooBig",
  "MessageRateExceeded",
  "MismatchSenderId",
  "InvalidCredentials",
]);
type MessageError = typeof MessageError.Type;
const isMessageError = Schema.is(MessageError);

/** The error codes Expo documents for a request it refused as a whole. */
const isRequestError = Schema.is(
  Schema.Literals([
    "TOO_MANY_REQUESTS",
    "PUSH_TOO_MANY_EXPERIENCE_IDS",
    "PUSH_TOO_MANY_NOTIFICATIONS",
    "PUSH_TOO_MANY_RECEIPTS",
    "UNAUTHORIZED",
  ]),
);

/** The reason logged for a code Expo does not document, or no code. */
const UNDOCUMENTED = "undocumented error";

/** Why Expo refused a message, when it says. */
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

/** Expo's documented code for a message's error, if it gave one. */
const codeOf = (details: typeof ErrorDetails.Type): MessageError | null => {
  const code = details?.error;
  return code !== undefined && isMessageError(code) ? code : null;
};

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
        Effect.map(({ errors }) => {
          const first = errors[0]?.code;
          return first !== undefined && isRequestError(first) ? first : UNDOCUMENTED;
        }),
        Effect.orElseSucceed(() => UNDOCUMENTED),
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

/** What one receipt says, in the sender's terms. */
const receiptOf = (receipt: typeof Receipt.Type): PushReceipt => {
  if (receipt.status === "ok") return { _tag: "delivered" };
  const code = codeOf(receipt.details);
  switch (code) {
    case "DeviceNotRegistered":
      return { _tag: "unregistered" };
    case "MessageRateExceeded":
      return { _tag: "throttled" };
    default:
      return { _tag: "rejected", reason: code ?? UNDOCUMENTED };
  }
};

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
      switch (code) {
        case "DeviceNotRegistered":
          return yield* new PushUnregistered();
        case "MessageRateExceeded":
          // Too many to this device just now: the same send may pass later.
          return yield* new PushThrottled();
        default:
          return yield* new PushRejected({ reason: code ?? UNDOCUMENTED });
      }
    });

    const receipts = Effect.fn("ExpoPushSender.receipts")(function* (
      ids: ReadonlyArray<PushReceiptId>,
    ) {
      const found = new Map<PushReceiptId, PushReceipt>();
      for (let start = 0; start < ids.length; start += RECEIPTS_PER_REQUEST) {
        const chunk = ids.slice(start, start + RECEIPTS_PER_REQUEST);
        const answered = yield* post(client, RECEIPTS_URL, { ids: chunk }, ReceiptsResponse).pipe(
          Effect.result,
        );
        if (answered._tag === "Failure") {
          // No answer about any message in it, a refusal of the request
          // included: they are asked about again, and the other chunks'
          // answers stand.
          yield* Effect.logInfo("Push receipts could not be read; they are asked for again").pipe(
            Effect.annotateLogs({ reason: answered.failure.reason, receipts: chunk.length }),
          );
          continue;
        }
        const { data } = answered.success;
        for (const id of chunk) {
          const receipt = data[id];
          if (receipt === undefined) continue;
          found.set(id, receiptOf(receipt));
        }
      }
      return found;
    });

    return PushSender.of({ send, receipts });
  }),
);
