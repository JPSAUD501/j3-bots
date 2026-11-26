// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ConnectorAppCsp,
  ConnectorAppHtml,
  ConnectorAppOrigin,
  fitsUtf8,
  MAX_CONNECTOR_APP_BYTES,
  MAX_CONNECTOR_APP_DOMAINS,
  MCP_APP_MIME_TYPE,
  visualEscapesGuard,
} from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A tool's app as its server gives it: the `ui://` resource a tool names
 * (the MCP Apps extension, decision 0048), read from what `resources/read`
 * answered. Its document and its policy, or why J3 Bots does not show it.
 */

/**
 * The most a `resources/read` of an app's document may weigh as JSON: the
 * document at `MAX_CONNECTOR_APP_BYTES`, base64 as a `blob`, and room for
 * the rest of the answer.
 */
export const MAX_APP_RESOURCE_JSON_BYTES = Math.ceil((MAX_CONNECTOR_APP_BYTES * 4) / 3) + 64 * 1024;

/** An app's document, ready to keep with the call that opened it. */
export interface AppDocument {
  readonly html: string;
  readonly csp: ConnectorAppCsp;
}

/**
 * Why a tool's app is not shown:
 * - `not-an-app`: the answer holds no content at that address of the
 *   extension's type, as text or base64, as a well-formed document.
 * - `too-large`: the document, or the answer that holds it, is larger than
 *   an app may be.
 * - `embeds-a-document`: its markup holds another document or a declarative
 *   shadow root, which the guard every app runs first could not watch.
 */
export type AppDocumentRefusal = "not-an-app" | "too-large" | "embeds-a-document";

const Content = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  blob: Schema.optionalKey(Schema.String),
  _meta: Schema.optionalKey(Schema.Unknown),
});
const ReadAnswer = Schema.Struct({ contents: Schema.Array(Schema.Unknown) });
const decodeAnswer = Schema.decodeUnknownOption(ReadAnswer);
const decodeContent = Schema.decodeUnknownOption(Content);

const UiMeta = Schema.Struct({
  ui: Schema.Struct({ csp: Schema.optionalKey(Schema.Unknown) }),
});
const decodeUiMeta = Schema.decodeUnknownOption(UiMeta);
const CspLists = Schema.Struct({
  connectDomains: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  resourceDomains: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  baseUriDomains: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const decodeCspLists = Schema.decodeUnknownOption(CspLists);
const isOrigin = Schema.is(ConnectorAppOrigin);
const decodeHtml = Schema.decodeUnknownOption(ConnectorAppHtml);

/**
 * The origins of one list J3 Bots allows, as a policy names them: lowercased,
 * a trailing `/` dropped, each once, and only those `ConnectorAppOrigin`
 * accepts, up to `MAX_CONNECTOR_APP_DOMAINS`. Anything else in the list is
 * left out, so the app may reach less than it asked, never more.
 */
const originsOf = (listed: ReadonlyArray<unknown> | undefined): ReadonlyArray<string> => {
  const origins = new Set<string>();
  for (const item of listed ?? []) {
    if (typeof item !== "string") continue;
    const origin = item.trim().toLowerCase().replace(/\/$/, "");
    if (isOrigin(origin)) origins.add(origin);
    if (origins.size === MAX_CONNECTOR_APP_DOMAINS) break;
  }
  return [...origins];
};

const NO_CSP: ConnectorAppCsp = { connectDomains: [], resourceDomains: [], baseUriDomains: [] };

/**
 * A content's `_meta.ui.csp`, read leniently: what it does not say, or says
 * wrongly, is the restrictive default. The rest of `_meta.ui` is not J3
 * Bots' to follow: it draws its own card around every app (`prefersBorder`),
 * and gives none an origin of its own (`domain`).
 */
const cspOf = (meta: unknown): ConnectorAppCsp =>
  Option.match(
    Option.flatMap(decodeUiMeta(meta), ({ ui }) => decodeCspLists(ui.csp)),
    {
      onNone: () => NO_CSP,
      onSome: (lists) => ({
        connectDomains: originsOf(lists.connectDomains),
        resourceDomains: originsOf(lists.resourceDomains),
        baseUriDomains: originsOf(lists.baseUriDomains),
      }),
    },
  );

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A `blob`'s bytes as UTF-8 text; none for one that is not base64, or not UTF-8. */
export const blobText = (blob: string): Option.Option<string> =>
  Option.flatMap(Result.getSuccess(Base64.decode(blob)), (bytes) => {
    try {
      return Option.some(utf8.decode(bytes));
    } catch {
      // Not UTF-8: the decoder is fatal.
      return Option.none();
    }
  });

/**
 * The app a `resources/read` of `uri` answered, as `session.readResource`
 * gives it (null when larger than {@link MAX_APP_RESOURCE_JSON_BYTES}): the
 * first content at `uri` of the extension's type, its document from `text`
 * or from `blob`, and its `_meta.ui`. The document must be one J3 Bots can
 * show: well formed, within `MAX_CONNECTOR_APP_BYTES`, with nothing in its
 * markup the guard could not watch.
 */
export const appDocumentOf = (
  answer: Schema.Json | null,
  uri: string,
): Result.Result<AppDocument, AppDocumentRefusal> => {
  if (answer === null) return Result.fail("too-large");
  const contents = Option.match(decodeAnswer(answer), {
    onNone: () => [],
    onSome: ({ contents }) => contents.flatMap((content) => Option.toArray(decodeContent(content))),
  });
  const content = contents.find(
    (candidate) => candidate.uri === uri && candidate.mimeType?.toLowerCase() === MCP_APP_MIME_TYPE,
  );
  if (content === undefined) return Result.fail("not-an-app");
  const text =
    content.text !== undefined
      ? Option.some(content.text)
      : content.blob !== undefined
        ? blobText(content.blob)
        : Option.none();
  if (Option.isNone(text)) return Result.fail("not-an-app");
  if (!fitsUtf8(text.value, MAX_CONNECTOR_APP_BYTES)) return Result.fail("too-large");
  const html = decodeHtml(text.value);
  if (Option.isNone(html)) return Result.fail("not-an-app");
  if (visualEscapesGuard(html.value)) return Result.fail("embeds-a-document");
  return Result.succeed({ html: html.value, csp: cspOf(content._meta) });
};
