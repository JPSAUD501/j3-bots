// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type Conflict,
  type Credential,
  type CredentialField,
  type CredentialFill,
  type FillOutcome,
  FillRefusal,
  type SiteOrigin,
  siteOriginOf,
  WorkStepId,
} from "@j3-bots/contracts";
import {
  BrowserBridge,
  type BrowserViewer,
  type EngineBrowserTab,
  type SessionId,
  type TabPage,
  type ViewerController,
} from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { BotStore } from "../bots/BotStore.ts";
import type { BotSession } from "../bots/EngineSessions.ts";
import { BrowserTabs } from "../browser/BrowserTabs.ts";
import { Observer } from "../turns/Observer.ts";
import { Vault } from "./Vault.ts";

// Filling a saved login into a bot's browser tab (`docs/architecture/server.md`,
// "Filling a login"). The server opens a viewer of the bot's front tab of its
// own, as a person's would be, takes the tab, so the bot's browser actions
// fail while it holds it, checks the page's committed address against the
// login's origins, types the value where the page has focus, and gives the
// tab back. The bot never sees the value: its tool result, the work step, the
// log and the tab's text all lack it. What the server cannot know is which
// field has focus, nor which frame it is in: the engine's viewer channel says
// neither (`docs/architecture/security.md`, "Filling a login").

/** What a fill asks, from a bot's `fill_credential`. */
export interface FillRequest {
  /** The bridge's id for the call: a forward retried under it gets the first answer. */
  readonly requestId: string;
  readonly caller: BotSession;
  /** The engine session the call came from, whose tabs are the bot's here. */
  readonly engineSessionId: SessionId;
  /** The login's name, as `list_credentials` gives it. */
  readonly credential: string;
  readonly field: CredentialField;
  readonly submit: boolean;
}

/** What `list_credentials` answers: names and origins, never a value. */
export type ListAnswer =
  | {
      readonly _tag: "listed";
      readonly credentials: ReadonlyArray<{
        readonly name: string;
        readonly origins: ReadonlyArray<SiteOrigin>;
      }>;
    }
  | { readonly _tag: "refused"; readonly reason: Extract<FillRefusal, "no-access" | "unavailable"> }
  | { readonly _tag: "locked" };

/** How long the server waits to hold the tab. */
export interface FillTiming {
  /** For the engine to say the server holds the tab. */
  readonly take: Duration.Duration;
  /** After Enter on a password, for the page to move on before the field is cleared. */
  readonly navigation: Duration.Duration;
  /** Between reads of the page while it waits. */
  readonly poll: Duration.Duration;
}

export const DEFAULT_FILL_TIMING: FillTiming = {
  take: Duration.seconds(5),
  navigation: Duration.seconds(6),
  poll: Duration.millis(250),
};

export class CredentialFills extends Context.Service<
  CredentialFills,
  {
    readonly list: (botId: BotId) => Effect.Effect<ListAnswer>;
    readonly fill: (request: FillRequest) => Effect.Effect<FillOutcome>;
  }
>()("@j3-bots/server/vault/Fill/CredentialFills") {}

/** Why nothing was typed. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: FillRefusal }) {}

/** The vault is locked: nothing was tried. */
class Locked extends Schema.TaggedError<Locked>()("Locked", {}) {}

const refused = (reason: FillRefusal) => new Refused({ reason });

/** What a fill makes of the vault's refusal: locked, or unavailable to it. */
const vaultRefusal = (conflict: Conflict): Effect.Effect<never, Locked | Refused> =>
  conflict.reason === "vault-locked"
    ? Effect.fail(new Locked())
    : Effect.fail(refused("unavailable"));

/**
 * Whether `url`'s host is this computer: `localhost`, `127.0.0.0/8` or `::1`.
 * Only there may a value go over plain `http:`.
 */
const isLoopback = (url: URL) =>
  url.hostname === "localhost" ||
  url.hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);

/**
 * The page's origin, as the URL parser gives it: scheme, ASCII host (a
 * punycode name stays punycode) and a port other than the scheme's default.
 * A page that is not `http:` or `https:`, or is plain `http:` on another
 * computer, is refused here.
 */
export const pageOrigin = (url: string): Effect.Effect<SiteOrigin, Refused> => {
  if (!URL.canParse(url)) return Effect.fail(refused("origin"));
  const parsed = new URL(url);
  if (parsed.protocol === "http:" && !isLoopback(parsed)) return Effect.fail(refused("insecure"));
  return Effect.fromOption(siteOriginOf(parsed.origin)).pipe(
    Effect.mapError(() => refused("origin")),
  );
};

/** A page the server may type into: loaded, at an address whose origin it knows. */
const loadedPage = (page: Option.Option<TabPage>) => {
  if (Option.isNone(page)) return Effect.fail(refused("no-tab"));
  switch (page.value._tag) {
    case "loading":
      return Effect.fail(refused("loading"));
    case "blank":
    case "failed":
      return Effect.fail(refused("origin"));
    case "loaded":
      return Effect.succeed(page.value.url);
  }
};

/** Enter, pressed and let go, as a keyboard sends it: it submits the form the focus is in. */
const ENTER_DOWN = {
  type: "key",
  action: "down",
  key: "Enter",
  code: "Enter",
  text: "\r",
  keyCode: 13,
  modifiers: 0,
} as const;
const ENTER_UP = {
  type: "key",
  action: "up",
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  modifiers: 0,
} as const;
const BACKSPACE_DOWN = {
  type: "key",
  action: "down",
  key: "Backspace",
  code: "Backspace",
  keyCode: 8,
  modifiers: 0,
} as const;
const BACKSPACE_UP = { ...BACKSPACE_DOWN, action: "up" } as const;

/** The most fills whose answer is kept for a retried forward. */
const ANSWERS_KEPT = 256;
/** The most tabs and turns a refusal is remembered for. */
const REFUSALS_KEPT = 1_024;

const AdmittedTurn = Schema.Struct({ admitted_turn_id: Schema.NullOr(Schema.String) });
const decodeAdmittedTurn = Schema.decodeUnknownEffect(Schema.Array(AdmittedTurn));

const WORDS: Record<FillOutcome["_tag"], string> = {
  filled: "Filled a saved login",
  refused: "Did not fill a saved login",
  locked: "Did not fill a saved login: the vault is locked",
};

export const layerWith = (timing: FillTiming) =>
  Layer.effect(
    CredentialFills,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const bots = yield* BotStore;
      const vault = yield* Vault;
      const bridge = yield* BrowserBridge;
      const tabs = yield* BrowserTabs;
      const observer = yield* Observer;
      const serverScope = yield* Effect.scope;
      /** One fill at a time: each holds a tab, and a person waits for none of them long. */
      const lock = yield* Semaphore.make(1);
      /** The answer of each recent fill, by its request id, for a forward retried under it. */
      const answers = new Map<string, Deferred.Deferred<FillOutcome>>();
      /** Each tab and turn a fill was refused on: it takes no other in that turn. */
      const refusals = new Set<string>();

      const remember = <K, V>(map: Map<K, V> | Set<K>, limit: number) => {
        const oldest = map.keys().next();
        if (map.size > limit && oldest.done !== true) map.delete(oldest.value);
      };

      /** The turn the caller's session runs, which a refusal on a tab lasts for. */
      const turnOf = (caller: BotSession) =>
        sql`SELECT admitted_turn_id FROM sessions WHERE id = ${caller.id}`.pipe(
          Effect.flatMap(decodeAdmittedTurn),
          Effect.map(([row]) => row?.admitted_turn_id ?? ""),
          Effect.orDie,
        );

      /** The logins the bot may use, while its vault access is on and the vault unlocked. */
      const usable = Effect.fnUntraced(function* (botId: BotId) {
        const found = yield* bots.find(botId);
        if (Option.isNone(found) || !found.value.bot.vault) return yield* refused("no-access");
        const all = yield* vault.list.pipe(
          Effect.catchTag(
            "Conflict",
            (conflict): Effect.Effect<ReadonlyArray<Credential>, Locked | Refused> =>
              conflict.reason === "vault-not-set-up" ? Effect.succeed([]) : vaultRefusal(conflict),
          ),
        );
        return all.filter((credential) => credential.allowedBots.includes(botId));
      });

      const list = (botId: BotId): Effect.Effect<ListAnswer> =>
        usable(botId).pipe(
          Effect.map((credentials): ListAnswer => ({
            _tag: "listed",
            credentials: credentials.map((credential) => ({
              name: credential.name,
              origins: credential.origins,
            })),
          })),
          Effect.catchTags({
            Locked: () => Effect.succeed<ListAnswer>({ _tag: "locked" }),
            Refused: (error) =>
              Effect.succeed<ListAnswer>({
                _tag: "refused",
                reason: error.reason === "no-access" ? "no-access" : "unavailable",
              }),
          }),
        );

      /**
       * Holds `tab` through a viewer of the server's own until the scope
       * closes, which gives it back: the engine releases a tab whose viewer
       * closes. Fails with `held` when a person holds it.
       */
      const hold = Effect.fnUntraced(function* (tab: EngineBrowserTab) {
        const viewer: BrowserViewer = yield* bridge
          .openViewer({ tab: tab.id, maxWidth: 64, maxHeight: 64, quality: 1 })
          .pipe(Effect.mapError(() => refused("unavailable")));
        const controller = yield* SubscriptionRef.make<ViewerController | "closed" | null>(null);
        // Pictures are never acknowledged, so the engine sends one at most.
        yield* viewer.output.pipe(
          Stream.runForEach((output) =>
            output._tag === "control"
              ? SubscriptionRef.set(controller, output.controller)
              : Effect.void,
          ),
          Effect.ignore,
          Effect.andThen(SubscriptionRef.set(controller, "closed")),
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() => viewer.send({ type: "release" }));
        yield* viewer.send({ type: "take" });
        const taken = yield* SubscriptionRef.changes(controller).pipe(
          Stream.filter((current) => current === "this-viewer" || current === "closed"),
          Stream.runHead,
          Effect.timeoutOption(timing.take),
          Effect.map(Option.flatten),
        );
        if (Option.getOrNull(taken) !== "this-viewer") {
          const now = yield* SubscriptionRef.get(controller);
          return yield* refused(now === "another-viewer" ? "held" : "unavailable");
        }
        const stillHeld = SubscriptionRef.get(controller).pipe(
          Effect.flatMap((current) =>
            current === "this-viewer" ? Effect.void : Effect.fail(refused("navigated")),
          ),
        );
        return { viewer, stillHeld };
      });

      const readPage = (tab: EngineBrowserTab) =>
        bridge.readTab(tab.id).pipe(Effect.mapError(() => refused("unavailable")));

      /** Returns once the page left `url`: it loads, failed, went elsewhere or closed. */
      const leaves = Effect.fnUntraced(function* (tab: EngineBrowserTab, url: string) {
        while (true) {
          const page = yield* readPage(tab).pipe(Effect.option);
          const moved = Option.exists(page, (current) =>
            Option.match(current, {
              onNone: () => true,
              onSome: (shown) => shown._tag !== "loaded" || shown.url !== url,
            }),
          );
          if (moved) return;
          yield* Effect.sleep(timing.poll);
        }
      });

      /** The fill itself, once the bot and the login are known to allow it. */
      const fillTab = Effect.fn("CredentialFills.fillTab")(function* (
        request: FillRequest,
        named: ReadonlyArray<Credential>,
        tab: EngineBrowserTab,
        seen: { origin: SiteOrigin | null; credential: Credential | null },
      ) {
        const { viewer, stillHeld } = yield* hold(tab);
        // Read from the engine now that the bot cannot act: its account of
        // where it is counts for nothing.
        const url = yield* loadedPage(yield* readPage(tab));
        const origin = yield* pageOrigin(url);
        seen.origin = origin;
        const matching = named.filter((credential) => credential.origins.includes(origin));
        if (matching.length === 0) return yield* refused("origin");
        if (matching.length > 1) return yield* refused("ambiguous");
        const [credential] = matching;
        if (credential === undefined) return yield* refused("origin");
        seen.credential = credential;
        const value = yield* vault.fillValue({ id: credential.id, field: request.field }).pipe(
          Effect.catchTags({
            NotFound: () => Effect.fail(refused("no-value")),
            Conflict: vaultRefusal,
          }),
        );
        // Again right before typing: a page that moved since types nothing.
        const again = yield* readPage(tab);
        if (Option.isNone(again) || again.value._tag !== "loaded" || again.value.url !== url) {
          return yield* refused("navigated");
        }
        yield* stillHeld;
        yield* viewer.send({ type: "text", text: Redacted.value(value) });
        const submitted = request.submit || request.field === "password";
        if (!submitted) return { submitted };
        yield* viewer.send(ENTER_DOWN);
        yield* viewer.send(ENTER_UP);
        if (request.field !== "password") return { submitted };
        // The bot gets the tab back on the page that follows; a page that
        // stays, as one that only shows an error does, has the password taken
        // out of the field first, one character at a time from where the
        // typing left the cursor.
        const moved = yield* leaves(tab, url).pipe(Effect.timeoutOption(timing.navigation));
        if (Option.isNone(moved)) {
          for (const _ of Redacted.value(value)) {
            yield* viewer.send(BACKSPACE_DOWN);
            yield* viewer.send(BACKSPACE_UP);
          }
        }
        return { submitted };
      }, Effect.scoped);

      const attempt = Effect.fn("CredentialFills.attempt")(function* (
        request: FillRequest,
        seen: { origin: SiteOrigin | null; credential: Credential | null },
      ) {
        const named = (yield* usable(request.caller.botId)).filter(
          (credential) => credential.name === request.credential,
        );
        if (named.length === 0) return yield* refused("unknown-login");
        const front = yield* tabs.frontOf(request.engineSessionId);
        if (Option.isNone(front)) return yield* refused("no-tab");
        const { tab, heldByDevice } = front.value;
        const key = `${tab.id}\u0000${request.caller.id}\u0000${yield* turnOf(request.caller)}`;
        if (refusals.has(key)) return yield* refused("refused-before");
        const filled = heldByDevice
          ? Effect.fail(refused("held"))
          : fillTab(request, named, tab, seen);
        return yield* filled.pipe(
          // Once the tab was looked at, a refusal holds for the tab and the
          // turn. A locked vault, a browser that did not answer or a person
          // holding the tab is no refusal of the page.
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (
                error._tag === "Refused" &&
                error.reason !== "unavailable" &&
                error.reason !== "held"
              ) {
                refusals.add(key);
                remember(refusals, REFUSALS_KEPT);
              }
            }),
          ),
        );
      });

      /** Records the fill as a step of the caller's running turn, and in the log, without a value. */
      const record = Effect.fn("CredentialFills.record")(function* (
        request: FillRequest,
        outcome: FillOutcome,
        seen: { origin: SiteOrigin | null; credential: Credential | null },
        startedAt: DateTime.Utc,
      ) {
        const fill: CredentialFill = {
          name: request.credential,
          credentialId: seen.credential?.id ?? null,
          field: request.field,
          origin: seen.origin,
          outcome,
        };
        yield* observer.serverStep(request.caller.id, {
          id: WorkStepId.make(`fill:${request.requestId}`),
          kind: "tool",
          tool: "login",
          label: WORDS[outcome._tag],
          status: outcome._tag === "filled" ? "completed" : "failed",
          startedAt,
          finishedAt: yield* DateTime.now,
          fill,
        });
        yield* Effect.logInfo(
          outcome._tag === "filled" ? "A saved login was filled" : "A saved login was not filled",
        ).pipe(
          Effect.annotateLogs({
            botId: request.caller.botId,
            credentialId: seen.credential?.id ?? null,
            field: request.field,
            outcome: outcome._tag,
            reason: outcome._tag === "refused" ? outcome.reason : null,
          }),
        );
      });

      const run = Effect.fn("CredentialFills.run")(function* (request: FillRequest) {
        const startedAt = yield* DateTime.now;
        const seen: { origin: SiteOrigin | null; credential: Credential | null } = {
          origin: null,
          credential: null,
        };
        const outcome = yield* attempt(request, seen).pipe(
          Effect.map(({ submitted }): FillOutcome => ({ _tag: "filled", submitted })),
          Effect.catchTags({
            Refused: (error) =>
              Effect.succeed<FillOutcome>({ _tag: "refused", reason: error.reason }),
            Locked: () => Effect.succeed<FillOutcome>({ _tag: "locked" }),
          }),
          lock.withPermits(1),
        );
        yield* record(request, outcome, seen, startedAt);
        return outcome;
      });

      /**
       * Runs a fill once per request id, in the server's scope rather than
       * the caller's: a forward the bridge gave up on does not cut a fill
       * short between typing and giving the tab back, and its retry waits for
       * the same answer.
       */
      const fill = Effect.fn("CredentialFills.fill")(function* (request: FillRequest) {
        const existing = answers.get(request.requestId);
        if (existing !== undefined) return yield* Deferred.await(existing);
        const answer = yield* Deferred.make<FillOutcome>();
        answers.set(request.requestId, answer);
        remember(answers, ANSWERS_KEPT);
        // A defect or an interruption reaches every waiter too, so none waits forever.
        yield* run(request).pipe(Deferred.into(answer), Effect.forkIn(serverScope));
        return yield* Deferred.await(answer);
      });

      return CredentialFills.of({ list, fill });
    }),
  );

export const layer = layerWith(DEFAULT_FILL_TIMING);
