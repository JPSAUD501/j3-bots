// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { OpenLiterals } from "./base.ts";
import { ReleaseVersion } from "./update.ts";

// The diagnostics zip (docs/decisions/0100-a-diagnostics-zip-holds-what-the-server-knows-and-nothing-of-the-person.md):
// one file, made by the server, that a person downloads from Settings → About
// and sends wherever they choose. Plain HTTP beside the protocol, because a
// file is what HTTP does well: the device token as a bearer, a JSON body, and
// the zip's bytes as the answer.

/**
 * The version of the diagnostics route, in its path. A server that has it
 * names it in `ServerInfo.diagnostics`, and a client offers "Download
 * diagnostics" only then.
 */
export const DIAGNOSTICS_API_VERSION = 1;

/**
 * `POST` a `DiagnosticsRequest` as `Content-Type: application/json`, with the
 * device token as `Authorization: Bearer`: every paired device is the
 * operator's. Answers 200 with the zip (`application/zip`); 401 with
 * `NotAuthenticated` without a valid token; 400 for a body that does not
 * decode; 415 for any other content type, before the body is read, so a page
 * elsewhere cannot ask for one without a preflight the server never grants.
 */
export const DIAGNOSTICS_HTTP_PATH = "/api/diagnostics/v1";

/** The clients a diagnostics zip can be downloaded from. */
export const DIAGNOSTICS_SURFACES = ["web", "desktop", "android"] as const;

/** The family of the system a client runs on, as far as it can tell. */
export const OS_FAMILIES = ["linux", "macos", "windows", "android", "ios", "other"] as const;

/**
 * The client that asks, which the zip's manifest records. Both sets are open:
 * a client newer than the server may name one the server does not know.
 */
export const DiagnosticsClient = Schema.Struct({
  surface: OpenLiterals(DIAGNOSTICS_SURFACES),
  /**
   * The release of the app that asks, or null for the web client, which the
   * server serves and so runs the server's own release.
   */
  version: Schema.NullOr(ReleaseVersion),
  os: OpenLiterals(OS_FAMILIES),
});
export type DiagnosticsClient = typeof DiagnosticsClient.Type;

export const DiagnosticsRequest = Schema.Struct({ client: DiagnosticsClient });
export type DiagnosticsRequest = typeof DiagnosticsRequest.Type;

/**
 * The most a diagnostics zip takes: the server keeps each log within its
 * budget, and the zip within this, so a client gives the download the time
 * this size takes.
 */
export const MAX_DIAGNOSTICS_SIZE = 24 * 1024 * 1024;

/** The zip's media type, as the route answers it and a client saves it. */
export const DIAGNOSTICS_MEDIA_TYPE = "application/zip";

const two = (value: number) => String(value).padStart(2, "0");

/**
 * The name a diagnostics zip made at `at` is saved under, in UTC:
 * `j3-bots-diagnostics-2026-11-27-1405.zip`. The same on every client and the
 * command line, so two made the same day sort by when.
 */
export const diagnosticsFileName = (at: DateTime.Utc): string => {
  const parts = DateTime.toPartsUtc(at);
  return `j3-bots-diagnostics-${parts.year}-${two(parts.month)}-${two(parts.day)}-${two(parts.hour)}${two(parts.minute)}.zip`;
};
