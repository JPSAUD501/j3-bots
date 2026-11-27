// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_LABEL_LENGTH, RegistryName } from "@j3-bots/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import { readText } from "../../body.ts";
import { type ConnectForm, connectForm, plainText } from "./form.ts";
import { owningDomain, rank } from "./ranking.ts";
import {
  decodeServerResponse,
  OFFICIAL_META,
  ServerPage,
  type ServerResponse,
} from "./serverJson.ts";

// The official MCP Registry (registry.modelcontextprotocol.io), searched
// through the server: clients never reach it, and the server never mirrors
// it. It holds tens of thousands of entries, most of them mass-published, and
// its search matches names only. So a search reads a few pages, within a
// size and a time budget, ranks what it read and keeps the best; results are
// cached for an hour, and an entry's details for a day. The registry is in
// preview and promises nothing about uptime, so a search it does not answer
// in time is reported as such, and the curated list still answers.
//
// The registry's data is dedicated to the public domain (CC0). Its terms ask
// that a consumer not imply an affiliation, which J3 Bots never does: a
// result says where it comes from, never that it is "official" or "verified".

const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";

/** Entries asked for in one page: the most the registry gives. */
const PAGE_SIZE = 100;

/** Pages one search reads at most. The registry orders by name, so later pages are other names, not worse ones. */
export const MAX_PAGES = 3;

/** The most bytes read from one answer. A full page is about 150 KB. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/** How long one request may take. */
export const REQUEST_TIMEOUT = Duration.seconds(5);

/** How long one search may take in all; what was read by then is used. */
export const SEARCH_BUDGET = Duration.seconds(8);

/** Results kept for one query, after ranking. */
const MAX_RESULTS = 40;

/** How long a search's results, and an entry's details, are reused. */
export const SEARCH_TTL = Duration.hours(1);
const DETAILS_TTL = Duration.hours(24);

/**
 * How long a search the registry did not answer is remembered as such, so
 * every keystroke of a search does not wait on a registry that is down.
 */
export const FAILURE_TTL = Duration.minutes(1);

/**
 * Queries and entries cached. With the caps on each result (form.ts) and on
 * the text kept, the caches stay within a few megabytes on a Raspberry Pi.
 */
const SEARCH_CAPACITY = 32;
const DETAILS_CAPACITY = 128;

/** Requests to the registry at once, across every search. */
const CONCURRENT_REQUESTS = 2;

/** The longest description kept: more than any card or page shows. */
const MAX_DESCRIPTION = 1000;

/** The registry did not answer, or not in time, or not in a form J3 Bots reads. */
class RegistryUnavailable extends Schema.TaggedError<RegistryUnavailable>()(
  "RegistryUnavailable",
  {},
) {}

/** A registry entry as J3 Bots offers it. All of its text is the publisher's, untrusted. */
export interface RegistryEntry {
  readonly name: RegistryName;
  /** The entry's title, or the part of its name after the slash. */
  readonly title: string;
  readonly description: string | null;
  /** The form of the first remote J3 Bots can connect, or null when it can connect none. */
  readonly form: ConnectForm | null;
  /** The domain that published the entry and owns that remote's host, if it does. */
  readonly owner: string | null;
}

const isRegistryName = Schema.is(RegistryName);

/**
 * The entry as J3 Bots offers it, or none: one the registry marks deleted or
 * deprecated, or with a name J3 Bots cannot address, is not offered.
 */
const entryOf = (response: ServerResponse): RegistryEntry | null => {
  const { server } = response;
  const status = response._meta?.[OFFICIAL_META]?.status;
  if (status !== undefined && status !== "active") return null;
  if (!isRegistryName(server.name)) return null;
  const usable = (server.remotes ?? []).flatMap((remote) => {
    const form = connectForm(remote);
    return Result.isSuccess(form) ? [form.success] : [];
  });
  const form = usable[0] ?? null;
  const own = server.name.slice(server.name.indexOf("/") + 1);
  return {
    name: server.name,
    title: plainText(server.title, MAX_LABEL_LENGTH) ?? own,
    description: plainText(server.description, MAX_DESCRIPTION),
    form,
    owner: form === null ? null : owningDomain(server.name, form.urlTemplate),
  };
};

/** What one page held, and where the next starts. */
interface Page {
  readonly entries: ReadonlyArray<RegistryEntry>;
  readonly next: string | null;
}

const decodePage = Schema.decodeUnknownOption(Schema.fromJsonString(ServerPage));
const decodeOne = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export class McpRegistry extends Context.Service<
  McpRegistry,
  {
    /**
     * The entries whose name has `query` in it, best first: those whose
     * publisher owns their host, then by how closely the name matches. At
     * most `MAX_RESULTS`, those J3 Bots can connect ahead of those it
     * cannot.
     */
    readonly search: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<RegistryEntry>, RegistryUnavailable>;
    /** The entry `name` names, or none when the registry has no such active entry. */
    readonly get: (
      name: RegistryName,
    ) => Effect.Effect<Option.Option<RegistryEntry>, RegistryUnavailable>;
  }
>()("@j3-bots/server/connectors/sources/Registry/McpRegistry") {}

/** A query as it is searched and cached: trimmed, in lower case, with single spaces. */
const normalizeQuery = (query: string) => query.trim().toLowerCase().replace(/\s+/g, " ");

export const layer = Layer.effect(
  McpRegistry,
  Effect.gen(function* () {
    // Each answer belongs to the scope of the read that asked for it, which
    // ends it however the read ends: one refused or cut off at the size cap
    // is never left open.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.withScope,
    );
    const permits = yield* Semaphore.make(CONCURRENT_REQUESTS);

    /**
     * The body of one answer, within the size cap, or why there is none. The
     * time limit counts the wait for a request slot too, so a search queued
     * behind others still ends within its budget.
     */
    const fetch = (url: URL, timeout: Duration.Duration) =>
      client.get(url, { acceptJson: true }).pipe(
        Effect.flatMap((response) => readText(response, MAX_ANSWER_BYTES)),
        permits.withPermits(1),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new RegistryUnavailable()),
        }),
        Effect.scoped,
        Effect.catchTags({
          HttpClientError: (error) =>
            error.reason._tag === "StatusCodeError" && error.reason.response.status === 404
              ? Effect.succeed(null)
              : Effect.fail(new RegistryUnavailable()),
          BodyTooLarge: () => Effect.fail(new RegistryUnavailable()),
        }),
      );

    const page = Effect.fn("McpRegistry.page")(function* (
      query: string,
      cursor: string | null,
      timeout: Duration.Duration,
    ) {
      const url = new URL(REGISTRY);
      url.searchParams.set("search", query);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("version", "latest");
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const body = yield* fetch(url, timeout);
      const decoded = body === null ? Option.none() : decodePage(body);
      if (Option.isNone(decoded)) return yield* new RegistryUnavailable();
      const entries = decoded.value.servers.flatMap((server) => {
        const one = decodeServerResponse(server);
        if (Option.isNone(one)) return [];
        const entry = entryOf(one.value);
        return entry === null ? [] : [entry];
      });
      const next = decoded.value.metadata?.nextCursor;
      return { entries, next: next === undefined || next === "" ? null : next } satisfies Page;
    });

    /**
     * Reads pages until there are no more, `MAX_PAGES` are read or the
     * budget is spent. A page after the first that fails ends the search with
     * what was read; a first that fails fails it.
     */
    const searchUpstream = Effect.fn("McpRegistry.searchUpstream")(function* (query: string) {
      const started = yield* Clock.currentTimeMillis;
      const budget = Duration.toMillis(SEARCH_BUDGET);
      const found: Array<RegistryEntry> = [];
      let cursor: string | null = null;
      for (let read = 0; read < MAX_PAGES; read++) {
        const left = budget - ((yield* Clock.currentTimeMillis) - started);
        if (left <= 0) break;
        const timeout = Duration.min(REQUEST_TIMEOUT, Duration.millis(left));
        const answer: Result.Result<Page, RegistryUnavailable> = yield* page(
          query,
          cursor,
          timeout,
        ).pipe(Effect.result);
        if (Result.isFailure(answer)) {
          if (read === 0) return yield* answer.failure;
          break;
        }
        found.push(...answer.success.entries);
        cursor = answer.success.next;
        if (cursor === null) break;
      }
      const connectable = rank(
        found.filter((entry) => entry.form !== null),
        query,
      );
      const rest = rank(
        found.filter((entry) => entry.form === null),
        query,
      );
      return [...connectable, ...rest].slice(0, MAX_RESULTS);
    });

    const getUpstream = Effect.fn("McpRegistry.getUpstream")(function* (name: RegistryName) {
      const url = new URL(`${REGISTRY}/${encodeURIComponent(name)}/versions/latest`);
      const body = yield* fetch(url, REQUEST_TIMEOUT);
      if (body === null) return Option.none<RegistryEntry>();
      const json = decodeOne(body);
      if (Option.isNone(json)) return yield* new RegistryUnavailable();
      const response = decodeServerResponse(json.value);
      if (Option.isNone(response)) return yield* new RegistryUnavailable();
      return Option.fromNullishOr(entryOf(response.value));
    });

    const ttl = (success: Duration.Duration) => (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isSuccess(exit) ? success : FAILURE_TTL;

    const searches = yield* Cache.makeWith(searchUpstream, {
      capacity: SEARCH_CAPACITY,
      timeToLive: ttl(SEARCH_TTL),
    });
    const details = yield* Cache.makeWith(getUpstream, {
      capacity: DETAILS_CAPACITY,
      timeToLive: ttl(DETAILS_TTL),
    });

    return McpRegistry.of({
      search: Effect.fn("McpRegistry.search")((query: string) =>
        Cache.get(searches, normalizeQuery(query)),
      ),
      get: Effect.fn("McpRegistry.get")((name: RegistryName) => Cache.get(details, name)),
    });
  }),
);
