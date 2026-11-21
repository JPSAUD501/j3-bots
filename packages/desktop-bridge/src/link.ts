// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  bareServerOrigin,
  EntryTarget,
  normalizePairingCode,
  PairingCode,
  parseUrl,
  ServerOrigin,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * What a link to the desktop app asks for: a conversation or a room opened, as
 * a notification click opens it (`open`), or the pairing screen filled in with
 * a server and a code (`pair`), which never pairs by itself.
 */
export const AppLink = Schema.Union([
  Schema.TaggedStruct("open", { target: EntryTarget }),
  Schema.TaggedStruct("pair", { server: ServerOrigin, code: PairingCode }),
]);
export type AppLink = typeof AppLink.Type;

/** `/<one segment>`, with at most a final `/`, as some systems add one to a link they hand over. */
const ONE_SEGMENT = /^\/([^/]+)\/?$/;

/** The id a link's path carries, percent-decoded; none when it is not one segment or not decodable. */
const idIn = (url: URL): Option.Option<string> =>
  url.search === ""
    ? Option.flatMap(Option.fromNullishOr(ONE_SEGMENT.exec(url.pathname)?.[1]), (segment) =>
        Option.liftThrowable(decodeURIComponent)(segment),
      )
    : Option.none();

/**
 * The only parameter of `params` named `name`, or none when it is missing or
 * given more than once.
 */
const single = (params: URLSearchParams, name: string): Option.Option<string> => {
  const values = params.getAll(name);
  return values.length === 1 ? Option.fromNullishOr(values[0]) : Option.none();
};

/**
 * What `text` asks for, in `AppLink`'s encoded form for its schema to check
 * (an id's length, a server's origin, a code's form),
 * or none when it is not a link of `scheme`'s shape: a host that names what it
 * opens, nothing else in its authority, no fragment, and only what that host
 * takes. A server is taken as typed on the server address screen would be, a
 * final `/` allowed; a code as a typed one is (`normalizePairingCode`).
 */
const read = (scheme: string, text: string): Option.Option<typeof AppLink.Encoded> =>
  Option.flatMap(parseUrl(text), (url) => {
    if (url.protocol !== `${scheme}:` || text.includes("#")) return Option.none();
    if (url.username !== "" || url.password !== "" || url.port !== "") return Option.none();
    switch (url.host) {
      case "bot":
        return Option.map(idIn(url), (botId) => ({
          _tag: "open" as const,
          target: { _tag: "conversation" as const, botId },
        }));
      case "room":
        return Option.map(idIn(url), (roomId) => ({
          _tag: "open" as const,
          target: { _tag: "room" as const, roomId },
        }));
      case "pair": {
        const params = url.searchParams;
        if (url.pathname !== "" && url.pathname !== "/") return Option.none();
        if ([...params.keys()].some((key) => key !== "server" && key !== "code")) {
          return Option.none();
        }
        return Option.zipWith(single(params, "server"), single(params, "code"), (server, code) => ({
          _tag: "pair" as const,
          // Anything that is not a bare origin is left as it is, for the schema to refuse.
          server: Option.getOrElse(bareServerOrigin(server), () => server),
          code: normalizePairingCode(code),
        }));
      }
      default:
        return Option.none();
    }
  });

/** `link` as a link of `scheme`. */
const write = (scheme: string, link: typeof AppLink.Encoded): string => {
  if (link._tag === "pair") {
    return `${scheme}://pair?${new URLSearchParams({ server: link.server, code: link.code })}`;
  }
  const { target } = link;
  return target._tag === "conversation"
    ? `${scheme}://bot/${encodeURIComponent(target.botId)}`
    : `${scheme}://room/${encodeURIComponent(target.roomId)}`;
};

/**
 * A link to the desktop app, in the scheme of the build it is for (`j3bots`,
 * or `j3bots-dev` for a development build, so the two never take each other's
 * links):
 *
 * - `<scheme>://bot/<id>` opens that bot's conversation;
 * - `<scheme>://room/<id>` opens that room;
 * - `<scheme>://pair?server=<origin>&code=<code>` fills in the pairing screen.
 *
 * An id is percent-encoded, as in the web client's addresses. Anything else
 * (another scheme, another host, a path beyond the id, an unknown or repeated
 * parameter, a server that is not an `http:` or `https:` origin, a code that is
 * missing or not a code) is not a link to the app.
 */
export const AppLinkUrl = (scheme: string) =>
  Schema.String.pipe(
    Schema.decodeTo(AppLink, {
      decode: SchemaGetter.transformEffect((text: string, options) =>
        Effect.fromOption(read(scheme, text)).pipe(
          Effect.mapError(
            () =>
              new SchemaIssue.InvalidValue(
                { message: `a ${scheme}: link to a bot, a room or pairing` },
                text,
                options,
              ),
          ),
        ),
      ),
      encode: SchemaGetter.transform((link: typeof AppLink.Encoded) => write(scheme, link)),
    }),
  );
