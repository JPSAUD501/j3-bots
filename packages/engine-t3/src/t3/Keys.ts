// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- engine ids are short SHA-256 digests of J3 Bots' durable keys.
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { IdempotencyKey } from "../ids.ts";

// Every engine id the adapter sends is derived from a key the server stored
// before the call, so a retry after a crash sends the same command, which the
// engine applies once (it is idempotent by command id, **Verified**).
//
// A dispatch's message id carries its key in clear, with the delivery it was
// sent as. That is how a run is traced back to its dispatch: the engine keeps
// the message id on the run it starts, on a follow-up run made of an unread
// steer and on the steer's own item.

const digest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

export const threadIdFor = (sessionKey: string) => `j3-session-${digest(sessionKey)}`;

export const projectIdFor = (workspacePath: string) => `j3-project-${digest(workspacePath)}`;

/** A command id for one purpose of one key. Purposes keep keys of different commands apart. */
export const commandIdFor = (purpose: string, key: string) => `j3-${purpose}-${digest(key)}`;

/**
 * J3 Bots' id for something the engine named: a turn item or a runtime
 * request. The engine's own ids nest provider and native ids and run past
 * 300 characters (**Verified**), longer than J3 Bots' ids may be. The same
 * engine id always gives the same J3 Bots id, so a replay and a replacement
 * name things the same way.
 */
export const localIdFor = (engineId: string) => `e-${digest(engineId)}`;

export type DeliveryKind = "start" | "steer";

export const messageIdFor = (delivery: DeliveryKind, key: IdempotencyKey) =>
  `j3-${delivery}:${key}`;

const MESSAGE = /^j3-(start|steer):(.+)$/s;
const decodeKey = Schema.decodeUnknownOption(IdempotencyKey);

/** The dispatch behind a message id, if J3 Bots sent it. */
export const dispatchOfMessage = (
  messageId: string,
): Option.Option<{ readonly delivery: DeliveryKind; readonly key: IdempotencyKey }> => {
  const match = MESSAGE.exec(messageId);
  const delivery = match?.[1];
  if (delivery !== "start" && delivery !== "steer") return Option.none();
  return Option.map(decodeKey(match?.[2]), (key) => ({ delivery, key }));
};
