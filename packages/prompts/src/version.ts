// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a synchronous hash of constant text at load; Effect's Digest is asynchronous and needs a service.
import { BotId, RoomId, RoutineId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { renderWakeWithNonce, type Wake } from "./envelope.ts";
import { BASE_TEMPLATE, BOT_TEMPLATE } from "./instructions.ts";
import { sharedSkills } from "./skills.ts";
import { toolList } from "./tools.ts";

/**
 * The prompt version: one identifier for the base prompt, the envelope format,
 * the tool descriptions and the skills J3 Bots ships together, derived from
 * their content. A session
 * records the version it was created with.
 *
 * The envelope format is code, so it enters the hash as rendered output: one
 * wake of every kind, with a fixed nonce. Any change to what a bot reads
 * changes the version; a change that leaves every text the same does not.
 */

const at = DateTime.makeUnsafe("2026-01-02T03:04:05Z");
const timeZone = DateTime.zoneMakeNamedUnsafe("America/Sao_Paulo");
const botId = Schema.decodeSync(BotId)("bot");
const teammate = { id: botId, name: "Bot", title: "Title" };
const message = { from: teammate, at, text: "text", urgent: false };
const base = { at, timeZone, sinceLastTurn: [] };

const SAMPLE_WAKES: ReadonlyArray<Wake> = [
  {
    ...base,
    kind: "user",
    sinceLastTurn: [
      { type: "routine-delivered", routine: "Routine", at, text: "text" },
      { type: "held-message", message },
      { type: "profile-changed", changes: [{ field: "job", value: "text" }] },
      {
        type: "session-rotated",
        digest: [
          { from: "user", text: "text", files: [] },
          { from: "you", text: "text", files: ["a.pdf"] },
        ],
      },
    ],
    answer: {
      question: "text",
      room: "Room",
      response: { type: "answered", chosen: [{ label: "label", value: "value" }], text: "text" },
    },
    messages: [
      { at, text: "text", attachments: [{ name: "a.pdf", path: "files/a.pdf", mediaType: "x" }] },
    ],
  },
  {
    ...base,
    kind: "user",
    sinceLastTurn: [{ type: "session-rotated", digest: [] }],
    answer: { question: "text", room: null, response: { type: "dismissed" } },
    messages: [],
  },
  {
    ...base,
    kind: "room",
    room: {
      id: Schema.decodeSync(RoomId)("room"),
      name: "Room",
      members: [teammate],
      hostName: "Bot",
    },
    reason: "host",
    omitted: 1,
    entries: [
      { author: "user", at, text: "text", mentions: "everyone", attachments: [] },
      { author: teammate, at, text: "text", mentions: ["Bot"] },
    ],
  },
  ...(["mentioned", "everyone"] as const).map((reason): Wake => ({
    ...base,
    kind: "room",
    room: {
      id: Schema.decodeSync(RoomId)("room"),
      name: "Room",
      members: [teammate],
      hostName: "Bot",
    },
    reason,
    omitted: 0,
    entries: [{ author: teammate, at, text: "text", mentions: [] }],
  })),
  { ...base, kind: "bot", messages: [message] },
  {
    ...base,
    kind: "routine",
    routine: {
      id: Schema.decodeSync(RoutineId)("routine"),
      name: "Routine",
      trigger: { type: "schedule", cron: "3 8 * * *" },
      instruction: "text",
    },
    recentRuns: [
      { at, outcome: { type: "delivered", text: "text" } },
      { at, outcome: { type: "silent", note: null } },
    ],
    triggerData: "text",
  },
  { ...base, kind: "system", event: { name: "first-run" } },
  {
    ...base,
    kind: "system",
    event: { name: "profile-changed", changes: [{ field: "name", value: "text" }] },
  },
  { ...base, kind: "system", event: { name: "undelivered" } },
];

const fingerprint = (): string => {
  const hash = createHash("sha256");
  for (const part of [
    BASE_TEMPLATE,
    BOT_TEMPLATE,
    JSON.stringify(toolList),
    ...sharedSkills.flatMap((skill) => [skill.name, skill.text]),
    ...SAMPLE_WAKES.map((wake) => renderWakeWithNonce(wake, "000000000000")),
  ]) {
    // Length-prefixed, so moving text from one part to the next changes the hash.
    hash.update(`${part.length}:${part}`);
  }
  return hash.digest("hex").slice(0, 12);
};

/** Twelve hex characters identifying the prompt texts this build renders. */
export const PROMPT_VERSION: string = fingerprint();
