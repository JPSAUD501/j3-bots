// SPDX-License-Identifier: AGPL-3.0-or-later
import { type SentTelemetryEvent, TelemetryModel, telemetryIdHash } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { SAMPLE_NOW } from "./sample";

// What the sample server sent, as "See what is sent" shows it. Every id is
// made up for the gallery.

const install = telemetryIdHash("gallery-install");
const laptop = telemetryIdHash("gallery-laptop");

const server = {
  installId: install,
  $process_person_profile: false,
  $geoip_disable: true,
  j3Version: "0.14.0",
  engineVersion: "0.1.13",
  os: "linux",
  arch: "x64",
  installKind: "service",
} as const;

const at = (minutesAgo: number) => DateTime.subtract(SAMPLE_NOW, { minutes: minutesAgo });

export const sampleSentEvents: ReadonlyArray<SentTelemetryEvent> = [
  {
    uuid: "019a7c3e-5b10-7c2a-9f41-2d6e0b8a1c03",
    event: "turn.finished",
    distinct_id: install,
    timestamp: at(2),
    properties: {
      harness: "claude-code",
      model: TelemetryModel.make("claude-opus-5-5"),
      effort: "high",
      origin: "conversation",
      outcome: "completed",
      failure: null,
      durationSeconds: 48,
      ...server,
    },
  },
  {
    uuid: "019a7c3d-9e02-7b11-8c20-5f1a3d4e6b02",
    event: "message.sent",
    distinct_id: install,
    timestamp: at(3),
    properties: {
      place: "conversation",
      mention: false,
      reply: true,
      quote: false,
      attachments: false,
      ...server,
      surface: "web",
      clientVersion: null,
      clientOs: "linux",
      clientDevice: laptop,
    },
  },
  {
    uuid: "019a7c1f-2a40-7e53-a1b2-0c9d8e7f6a01",
    event: "install.active",
    distinct_id: install,
    timestamp: at(95),
    properties: { bots: "4-10", rooms: "1", routines: "2-3", connectors: "2-3", ...server },
  },
];
