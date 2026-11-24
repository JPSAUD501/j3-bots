// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";

// The parts of the official MCP Registry's answers J3 Bots reads: a server's
// `server.json` (schema 2025-12-11) and the registry's metadata about it.
// Unknown keys are ignored, so a newer schema that adds fields still decodes.
// Everything here was written by whoever published the server and is
// untrusted: it is decoded, capped and mapped before anything else sees it.

/**
 * One value a server asks for: a header, a header's variable or a URL
 * variable. `value` is fixed by the publisher; braces in it name `variables`.
 */
export const Input = Schema.Struct({
  description: Schema.optional(Schema.String),
  isRequired: Schema.optional(Schema.Boolean),
  isSecret: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.String)),
  placeholder: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});
export type Input = typeof Input.Type;

/** A header the remote takes, which may itself have variables. */
export const Header = Schema.Struct({
  ...Input.fields,
  name: Schema.String,
  variables: Schema.optional(Schema.Record(Schema.String, Input)),
});
export type Header = typeof Header.Type;

/** One address the server answers on, with what a client must send it. */
export const Remote = Schema.Struct({
  /** `streamable-http` or `sse`; others may come. */
  type: Schema.String,
  /** A URL template: braces name `variables`. */
  url: Schema.String,
  headers: Schema.optional(Schema.Array(Header)),
  variables: Schema.optional(Schema.Record(Schema.String, Input)),
});
export type Remote = typeof Remote.Type;

const Server = Schema.Struct({
  /** Reverse-DNS namespace, a slash, and a name: `com.example/mcp`. */
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  remotes: Schema.optional(Schema.Array(Remote)),
});

/** What the registry says about the entry, apart from what its publisher wrote. */
const Official = Schema.Struct({
  /** `active`, `deprecated` or `deleted`. */
  status: Schema.optional(Schema.String),
  isLatest: Schema.optional(Schema.Boolean),
});

export const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

/** One entry as `GET /v0.1/servers/{name}/versions/latest` answers. */
export const ServerResponse = Schema.Struct({
  server: Server,
  _meta: Schema.optional(Schema.Struct({ [OFFICIAL_META]: Schema.optional(Official) })),
});
export type ServerResponse = typeof ServerResponse.Type;

/**
 * A page of `GET /v0.1/servers`. Each entry is decoded on its own, so one a
 * publisher got wrong drops only itself.
 */
export const ServerPage = Schema.Struct({
  servers: Schema.Array(Schema.Unknown),
  metadata: Schema.optional(Schema.Struct({ nextCursor: Schema.optional(Schema.String) })),
});

export const decodeServerResponse = Schema.decodeUnknownOption(ServerResponse);
