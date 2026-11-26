// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a synchronous hash of constant text at load; Effect's Digest is asynchronous and needs a service.
import { BotId, RoomId, RoutineId, RoutineRunId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import {
  CONNECTOR_UNAVAILABLE,
  type ConnectorResult,
  connectorToolDescription,
  listingText,
  NOTHING_LISTED,
  renderConnectorResultWithNonce,
} from "./connectorResult.ts";
import { renderWakeWithNonce, type Wake } from "./envelope.ts";
import {
  BASE_TEMPLATE,
  BOT_TEMPLATE,
  BROWSER_TEMPLATE,
  CONNECTORS_TEMPLATE,
} from "./instructions.ts";
import {
  renderRoomMovedOnWithNonce,
  renderRoomReadWithNonce,
  type RoomRead,
  type RoomReadEntry,
} from "./roomRead.ts";
import { sharedSkills } from "./skills.ts";
import {
  BROWSER_HELP_REQUESTED,
  FILL_NOTES,
  MANAGEMENT_NOTES,
  MANAGEMENT_REFUSED,
  preApprovedTools,
  SECRET_ASK_EXISTS,
  SECRET_ASK_SHOWN,
  toolList,
} from "./tools.ts";

/**
 * The prompt version: one identifier for the base prompt, the envelope format,
 * the tool descriptions, what the tools answer and the skills J3 Bots ships
 * together, derived from their content. A session
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
      {
        at,
        text: "text",
        attachments: [{ name: "a.pdf", path: "files/a.pdf", mediaType: "x", offset: null }],
      },
      {
        at,
        text: "text text",
        attachments: [{ name: "a.png", path: "files/a.png", mediaType: "x", offset: 4 }],
      },
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
    },
    reason: "user",
    closing: true,
    omitted: 1,
    entries: [
      { author: "user", at, text: "text", mentions: "everyone", attachments: [] },
      { author: teammate, at, text: "text", mentions: ["Bot"], files: ["a.pdf"] },
    ],
  },
  ...(["kickoff", "addressed", "everyone", "member"] as const).map((reason): Wake => ({
    ...base,
    kind: "room",
    room: {
      id: Schema.decodeSync(RoomId)("room"),
      name: "Room",
      members: [teammate],
    },
    reason,
    closing: false,
    omitted: 0,
    entries: [{ author: teammate, at, text: "text", mentions: [], files: [] }],
  })),
  { ...base, kind: "bot", messages: [message] },
  // Every way the recent runs read: listed or none, and with runs left out to fit or not.
  ...[
    [
      { at, outcome: { type: "delivered", text: "text" } },
      { at, outcome: { type: "silent", note: null } },
    ] as const,
    [],
  ].flatMap((recentRuns) =>
    [false, true].map((recentRunsLeftOut): Wake => ({
      ...base,
      kind: "routine",
      routine: {
        id: Schema.decodeSync(RoutineId)("routine"),
        name: "Routine",
        trigger: { type: "schedule", cron: "3 8 * * *" },
        instruction: "text",
      },
      runId: Schema.decodeSync(RoutineRunId)("run"),
      recentRuns,
      recentRunsLeftOut,
      triggerData: "text",
      dueAt: at,
    })),
  ),
  ...[false, true].flatMap((askName) =>
    [false, true].map((fromTemplate): Wake => ({
      ...base,
      kind: "system",
      event: { name: "first-run", askName, fromTemplate },
    })),
  ),
  {
    ...base,
    kind: "system",
    event: { name: "profile-changed", changes: [{ field: "name", value: "text" }] },
  },
  { ...base, kind: "system", event: { name: "undelivered" } },
  { ...base, kind: "system", event: { name: "delegated-result", text: "text" } },
  ...(["done", "declined", "tab-closed", "timed-out", "handed-back"] as const).map(
    (outcome): Wake => ({
      ...base,
      kind: "system",
      event: { name: "browser-help", outcome, site: "text" },
    }),
  ),
  ...(["saved", "declined", "expired"] as const).map((outcome): Wake => ({
    ...base,
    kind: "system",
    event: { name: "secret-ask", outcome, reference: "secret:name" },
  })),
];

const SAMPLE_CONNECTOR_RESULTS: ReadonlyArray<ConnectorResult> = [
  {
    type: "answer",
    connector: "Connector",
    tool: "tool",
    text: "text",
    isError: false,
    cut: false,
  },
  { type: "answer", connector: "Connector", tool: "tool", text: "text", isError: true, cut: true },
  {
    type: "data",
    connector: "Connector",
    slug: "connector",
    about: { kind: "resource", uri: "note://one" },
    text: "text",
    cut: false,
  },
  {
    type: "data",
    connector: "Connector",
    slug: "connector",
    about: { kind: "prompt", name: "prompt" },
    text: "text",
    cut: true,
  },
  {
    type: "data",
    connector: "Connector",
    slug: "connector",
    about: { kind: "listing", of: "resources" },
    ...listingText({
      of: "resources",
      items: [
        {
          kind: "template",
          uri: "note://{id}",
          name: "note",
          title: "Note",
          description: "text",
          mimeType: "text/plain",
        },
      ],
    }),
  },
  {
    type: "data",
    connector: "Connector",
    slug: "connector",
    about: { kind: "listing", of: "prompts" },
    ...listingText({
      of: "prompts",
      items: [
        {
          name: "prompt",
          title: "Prompt",
          description: "text",
          arguments: [{ name: "topic", description: "text", required: true }],
        },
      ],
    }),
  },
  ...CONNECTOR_UNAVAILABLE.map((reason): ConnectorResult => ({
    type: "unavailable",
    connector: "Connector",
    reason,
  })),
];

const SAMPLE_ROOM = { id: Schema.decodeSync(RoomId)("room"), name: "Room" };
const SAMPLE_ROOM_ENTRIES: readonly [...Array<RoomReadEntry>, RoomReadEntry] = [
  { author: { type: "user", name: "Name" }, at, text: "text", mentions: "everyone", files: [] },
  { author: { type: "you" }, at, text: "text", mentions: [], files: [] },
  { author: { type: "teammate", teammate }, at, text: "text", mentions: ["Bot"], files: ["a.pdf"] },
];
const SAMPLE_ROOM_READS: ReadonlyArray<RoomRead> = [
  {
    at,
    timeZone,
    room: { ...SAMPLE_ROOM, archived: false },
    search: null,
    entries: [],
    earlier: 0,
    cut: false,
  },
  {
    at,
    timeZone,
    room: { ...SAMPLE_ROOM, archived: true },
    search: "text",
    entries: [],
    earlier: 0,
    cut: false,
  },
  {
    at,
    timeZone,
    room: { ...SAMPLE_ROOM, archived: false },
    search: null,
    entries: SAMPLE_ROOM_ENTRIES,
    earlier: 1,
    cut: true,
  },
  {
    at,
    timeZone,
    room: { ...SAMPLE_ROOM, archived: false },
    search: "text",
    entries: SAMPLE_ROOM_ENTRIES,
    earlier: 2,
    cut: false,
  },
];

const fingerprint = (): string => {
  const hash = createHash("sha256");
  for (const part of [
    BASE_TEMPLATE,
    BOT_TEMPLATE,
    BROWSER_TEMPLATE,
    CONNECTORS_TEMPLATE,
    JSON.stringify(toolList),
    BROWSER_HELP_REQUESTED,
    SECRET_ASK_SHOWN,
    SECRET_ASK_EXISTS,
    ...Object.values(FILL_NOTES),
    ...Object.values(MANAGEMENT_NOTES),
    ...Object.values(MANAGEMENT_REFUSED).map((refusal) =>
      typeof refusal === "string" ? refusal : refusal("name"),
    ),
    JSON.stringify(preApprovedTools),
    ...sharedSkills.flatMap((skill) => [skill.name, skill.text]),
    ...SAMPLE_WAKES.map((wake) => renderWakeWithNonce(wake, "000000000000")),
    connectorToolDescription("Connector", "text"),
    ...Object.values(NOTHING_LISTED),
    ...SAMPLE_CONNECTOR_RESULTS.map((result) =>
      renderConnectorResultWithNonce(result, "000000000000"),
    ),
    ...SAMPLE_ROOM_READS.map((read) => renderRoomReadWithNonce(read, "000000000000")),
    renderRoomMovedOnWithNonce(
      { at, timeZone, room: SAMPLE_ROOM, entries: SAMPLE_ROOM_ENTRIES, omitted: 1 },
      "000000000000",
    ),
  ]) {
    // Length-prefixed, so moving text from one part to the next changes the hash.
    hash.update(`${part.length}:${part}`);
  }
  return hash.digest("hex").slice(0, 12);
};

/** Twelve hex characters identifying the prompt texts this build renders. */
export const PROMPT_VERSION: string = fingerprint();
