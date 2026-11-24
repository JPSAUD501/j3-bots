// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type Conflict,
  type Credential,
  type CredentialField,
  type CredentialFill,
  FillOutcome,
  FillRefusal,
  type SiteOrigin,
  siteOriginOf,
  WorkStepId,
} from "@j3-bots/contracts";
import {
  BrowserBridge,
  type BrowserViewer,
  type EngineBrowserTab,
  type EngineTabId,
  type SessionId,
  type TabPage,
  type TurnId,
  type ViewerController,
} from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { BotStore } from "../bots/BotStore.ts";
import type { BotSession } from "../bots/EngineSessions.ts";
import { BrowserTabs } from "../browser/BrowserTabs.ts";
import {
  type FillCall,
  type FillClaim,
  type TurnEnded,
  type TurnToolRefused,
  type TurnToolRetry,
  TurnTools,
} from "../tools/TurnTools.ts";
import { Observer } from "../turns/Observer.ts";
import { Vault } from "./Vault.ts";

// Filling a saved login into a bot's browser tab (`docs/architecture/server.md`,
// "Filling a login"). The call is first pinned to the engine's record of it in
// the caller's turn. Then the server opens a viewer of the bot's front tab of
// its own, as a person's would be, takes the tab, so the bot's browser actions
// fail while it holds it, checks the page's committed address against the
// login's origins, types the value where the page has focus, waits until the
// engine has run that input, and gives the tab back. The bot never sees the
// value: its tool result, the work step, the log and the tab's text all lack
// it. What the server cannot know is which field has focus, nor which frame
// it is in: the engine's viewer channel says neither
// (`docs/architecture/security.md`, "Filling a login").

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
  /** As the bridge received them: what the call is matched to the engine's record by. */
  readonly arguments: Schema.Json;
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

/** How long the server waits on the engine and the page. */
interface FillTiming {
  /** For the engine to say the server holds the tab, and to answer the probe after the typing. */
  readonly take: Duration.Duration;
  /** After Enter on a password, for the page to load another before the field is cleared. */
  readonly navigation: Duration.Duration;
  /** Between reads of the page while it waits. */
  readonly poll: Duration.Duration;
}

const TIMING: FillTiming = {
  take: Duration.seconds(5),
  navigation: Duration.seconds(6),
  poll: Duration.millis(100),
};

/** Why a fill was not even tried: the call is not one of the caller's turn. */
export type FillCallRefused = TurnEnded | TurnToolRefused | TurnToolRetry | Conflict;

export class CredentialFills extends Context.Service<
  CredentialFills,
  {
    readonly list: (botId: BotId) => Effect.Effect<ListAnswer>;
    readonly fillLogin: (request: FillRequest) => Effect.Effect<FillOutcome, FillCallRefused>;
  }
>()("@j3-bots/server/vault/Fill/CredentialFills") {}

/** A fill's call, pinned to its turn. */
type Claimed = Extract<FillClaim, { readonly _tag: "claimed" }>;

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
 * A page whose own address is not `http:` or `https:` is refused, a `blob:`
 * one included, whose origin is the address inside it; so is plain `http:` on
 * another computer.
 */
const pageOrigin = (url: string): Effect.Effect<SiteOrigin, Refused> => {
  if (!URL.canParse(url)) return Effect.fail(refused("origin"));
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Effect.fail(refused("origin"));
  }
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

/**
 * The one login named `name` that is saved for `origin`, among `credentials`.
 * None gives `origin`, more than one `ambiguous`.
 */
const loginFor = (
  credentials: ReadonlyArray<Credential>,
  name: string,
  origin: SiteOrigin,
): Effect.Effect<Credential, Refused> => {
  const matching = credentials.filter(
    (credential) => credential.name === name && credential.origins.includes(origin),
  );
  const [credential, ...others] = matching;
  if (credential === undefined) return Effect.fail(refused("origin"));
  if (others.length > 0) return Effect.fail(refused("ambiguous"));
  return Effect.succeed(credential);
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

/** The most fills whose answer is kept for a forward retried while the server runs. */
const ANSWERS_KEPT = 256;

const WORDS: Record<FillOutcome["_tag"], string> = {
  filled: "Filled a saved login",
  refused: "Did not fill a saved login",
  locked: "Did not fill a saved login: the vault is locked",
};

const encodeOutcome = Schema.encodeEffect(Schema.toCodecJson(FillOutcome));
const decodeOutcome = Schema.decodeUnknownEffect(Schema.toCodecJson(FillOutcome));

/** What the engine says of the tab the server's viewer holds, as the viewer hears it. */
interface Heard {
  readonly controller: ViewerController | "closed" | null;
  /** How many probes the engine answered. */
  readonly probes: number;
}

const make = (timing: FillTiming) =>
  Layer.effect(
    CredentialFills,
    Effect.gen(function* () {
      const bots = yield* BotStore;
      const vault = yield* Vault;
      const bridge = yield* BrowserBridge;
      const tabs = yield* BrowserTabs;
      const observer = yield* Observer;
      const turnTools = yield* TurnTools;
      const serverScope = yield* Effect.scope;
      /** One fill at a time: each holds a tab, and a person waits for none of them long. */
      const lock = yield* Semaphore.make(1);
      /** The answer of each recent fill, by its request id, for a forward retried under it. */
      const answers = new Map<string, Deferred.Deferred<FillOutcome, FillCallRefused>>();
      /**
       * For each session, the turn a fill last ran in and the tabs a fill was
       * refused on in it, which take no other until that turn is over. A
       * session's next turn replaces its entry.
       */
      const refusals = new Map<
        string,
        { readonly turnId: TurnId; readonly tabs: Set<EngineTabId> }
      >();

      const refusedTabsOf = (request: FillRequest, turnId: TurnId) => {
        const current = refusals.get(request.caller.id);
        if (current !== undefined && current.turnId === turnId) return current.tabs;
        const fresh = { turnId, tabs: new Set<EngineTabId>() };
        refusals.set(request.caller.id, fresh);
        return fresh.tabs;
      };

      /**
       * The logins the bot may use: while its vault access and its browser
       * are on and the vault unlocked, those that allow it.
       */
      const usable = Effect.fnUntraced(function* (botId: BotId) {
        const found = yield* bots.find(botId);
        if (Option.isNone(found) || !found.value.bot.vault || !found.value.bot.browser) {
          return yield* refused("no-access");
        }
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
        const heard = yield* SubscriptionRef.make<Heard>({ controller: null, probes: 0 });
        // Pictures are never acknowledged, so the engine sends one at most.
        yield* viewer.output.pipe(
          Stream.runForEach((output) => {
            switch (output._tag) {
              case "control":
                return SubscriptionRef.update(heard, (now) => ({
                  ...now,
                  controller: output.controller,
                }));
              case "probe":
                return SubscriptionRef.update(heard, (now) => ({ ...now, probes: now.probes + 1 }));
              default:
                return Effect.void;
            }
          }),
          Effect.ignore,
          Effect.andThen(
            SubscriptionRef.update(heard, (now) => ({ ...now, controller: "closed" as const })),
          ),
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() => viewer.send({ type: "release" }));
        yield* viewer.send({ type: "take" });
        const taken = yield* SubscriptionRef.changes(heard).pipe(
          Stream.map((now) => now.controller),
          Stream.filter((current) => current === "this-viewer" || current === "closed"),
          Stream.runHead,
          Effect.timeoutOption(timing.take),
          Effect.map(Option.flatten),
        );
        if (Option.getOrNull(taken) !== "this-viewer") {
          const now = yield* SubscriptionRef.get(heard);
          return yield* refused(now.controller === "another-viewer" ? "held" : "unavailable");
        }
        const stillHeld = SubscriptionRef.get(heard).pipe(
          Effect.flatMap((now) =>
            now.controller === "this-viewer" ? Effect.void : Effect.fail(refused("navigated")),
          ),
        );
        /**
         * Returns once the engine has run every input sent before it. The
         * engine runs a holder's input one action at a time, in order, and a
         * release drops what is still waiting, so the tab is given back only
         * after this. A probe is answered by the engine from the same line,
         * so its answer says the input ahead of it ran.
         */
        const drained = Effect.gen(function* () {
          const before = (yield* SubscriptionRef.get(heard)).probes;
          yield* viewer.send({ type: "probe", x: 0, y: 0 });
          const answered = yield* SubscriptionRef.changes(heard).pipe(
            Stream.filter((now) => now.probes > before || now.controller !== "this-viewer"),
            Stream.runHead,
            Effect.timeoutOption(timing.take),
            Effect.map(Option.flatten),
          );
          if (Option.isNone(answered) || answered.value.controller !== "this-viewer") {
            yield* Effect.logWarning("The browser did not confirm a fill's typing in time");
            return yield* refused("unavailable");
          }
        });
        return { viewer, stillHeld, drained };
      });

      const readPage = (tab: EngineBrowserTab) =>
        bridge.readTab(tab.id).pipe(Effect.mapError(() => refused("unavailable")));

      /**
       * Whether the page a password was submitted from is gone, within the
       * navigation wait: the tab closed, failed, went blank, or loaded
       * another address after it was seen loading. Anything short of that
       * counts as staying, and the field is cleared. That covers a page that
       * only changes its address with `history.pushState`, which the engine
       * reports as loaded at the new one; a submission the server answers
       * with no new document; and a sign-in still loading when the wait ends.
       */
      const left = Effect.fnUntraced(function* (tab: EngineBrowserTab, url: string) {
        let loading = false;
        const settled = Effect.gen(function* () {
          while (true) {
            const page = yield* readPage(tab).pipe(Effect.option);
            if (Option.isSome(page)) {
              if (Option.isNone(page.value)) return true;
              const shown = page.value.value;
              if (shown._tag === "blank" || shown._tag === "failed") return true;
              if (shown._tag === "loading") loading = true;
              else if (loading) return shown.url !== url;
            }
            yield* Effect.sleep(timing.poll);
          }
        });
        const answer = yield* settled.pipe(Effect.timeoutOption(timing.navigation));
        return Option.getOrElse(answer, () => false);
      });

      /** The fill itself, once the bot and the login are known to allow it. */
      const fillTab = Effect.fn("CredentialFills.fillTab")(function* (
        request: FillRequest,
        claim: Claimed,
        tab: EngineBrowserTab,
        seen: { origin: SiteOrigin | null; credential: Credential | null },
      ) {
        const { viewer, stillHeld, drained } = yield* hold(tab);
        // Read from the engine now that the bot cannot act: its account of
        // where it is counts for nothing.
        const url = yield* loadedPage(yield* readPage(tab));
        const origin = yield* pageOrigin(url);
        seen.origin = origin;
        const botId = request.caller.botId;
        const found = yield* loginFor(yield* usable(botId), request.credential, origin);
        seen.credential = found;
        // The value comes with the login as it was when it was opened, so a
        // change to the login in between cannot pair a new value with the
        // origins it had before.
        const { value, credential } = yield* vault
          .fillValue({ id: found.id, field: request.field })
          .pipe(
            Effect.catchTags({
              NotFound: () => Effect.fail(refused("no-value")),
              Conflict: vaultRefusal,
            }),
          );
        if (!credential.allowedBots.includes(botId)) return yield* refused("unknown-login");
        yield* loginFor([credential], request.credential, origin);
        // Again right before typing: a page that moved types nothing. Then
        // what the operator may have changed since the take: the bot's
        // switches, the login's bots, and the turn, which they may have
        // stopped while this fill waited for another.
        const again = yield* readPage(tab);
        if (Option.isNone(again) || again.value._tag !== "loaded" || again.value.url !== url) {
          return yield* refused("navigated");
        }
        const still = yield* loginFor(yield* usable(botId), request.credential, origin);
        if (still.id !== credential.id) return yield* refused("origin");
        if (!(yield* claim.stillOpen)) return yield* refused("stopped");
        yield* stillHeld;
        yield* viewer.send({ type: "text", text: Redacted.value(value) });
        const submitted = request.submit || request.field === "password";
        if (submitted) {
          yield* viewer.send(ENTER_DOWN);
          yield* viewer.send(ENTER_UP);
        }
        yield* drained;
        if (request.field !== "password") return { submitted };
        // The bot gets the tab back on the page that follows. A page that
        // stays, as one that only shows an error does, has the password
        // taken out of the field first, one character at a time from where
        // the typing left the cursor.
        if (!(yield* left(tab, url))) {
          for (const _ of Redacted.value(value)) {
            yield* viewer.send(BACKSPACE_DOWN);
            yield* viewer.send(BACKSPACE_UP);
          }
          yield* drained;
        }
        return { submitted };
      }, Effect.scoped);

      const attempt = Effect.fn("CredentialFills.attempt")(function* (
        request: FillRequest,
        claim: Claimed,
        seen: { origin: SiteOrigin | null; credential: Credential | null },
      ) {
        const named = (yield* usable(request.caller.botId)).filter(
          (credential) => credential.name === request.credential,
        );
        if (named.length === 0) return yield* refused("unknown-login");
        const front = yield* tabs.frontOf(request.engineSessionId);
        if (Option.isNone(front)) return yield* refused("no-tab");
        const { tab, heldByDevice } = front.value;
        const refusedTabs = refusedTabsOf(request, claim.turnId);
        if (refusedTabs.has(tab.id)) return yield* refused("refused-before");
        const filled = heldByDevice
          ? Effect.fail(refused("held"))
          : fillTab(request, claim, tab, seen);
        return yield* filled.pipe(
          // Once the tab was looked at, a refusal holds for the tab and the
          // turn. A locked vault, a browser that did not answer, a person
          // holding the tab or a stopped turn is no refusal of the page.
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (
                error._tag === "Refused" &&
                error.reason !== "unavailable" &&
                error.reason !== "held" &&
                error.reason !== "stopped"
              ) {
                refusedTabs.add(tab.id);
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

      /** A fill claimed for `turnId`, run, recorded, and its answer stored for its call. */
      const run = Effect.fn("CredentialFills.run")(function* (
        request: FillRequest,
        call: FillCall,
      ) {
        const claim = yield* turnTools.claimFill(call);
        if (claim._tag === "stored") return yield* decodeOutcome(claim.result).pipe(Effect.orDie);
        const startedAt = yield* DateTime.now;
        const seen: { origin: SiteOrigin | null; credential: Credential | null } = {
          origin: null,
          credential: null,
        };
        const outcome = yield* attempt(request, claim, seen).pipe(
          Effect.map(({ submitted }): FillOutcome => ({ _tag: "filled", submitted })),
          Effect.catchTags({
            Refused: (error) =>
              Effect.succeed<FillOutcome>({ _tag: "refused", reason: error.reason }),
            Locked: () => Effect.succeed<FillOutcome>({ _tag: "locked" }),
          }),
          lock.withPermits(1),
        );
        yield* record(request, outcome, seen, startedAt);
        yield* turnTools.settleFill(call, yield* encodeOutcome(outcome).pipe(Effect.orDie));
        return outcome;
      });

      /**
       * Runs a fill once per request id, in the server's scope rather than
       * the caller's: a forward the bridge gave up on does not cut a fill
       * short between typing and giving the tab back, and its retry waits for
       * the same answer. A request that could not be claimed is forgotten, so
       * its retry is claimed afresh.
       */
      const fillLogin = Effect.fn("CredentialFills.fillLogin")(function* (request: FillRequest) {
        const existing = answers.get(request.requestId);
        if (existing !== undefined) return yield* Deferred.await(existing);
        const answer = yield* Deferred.make<FillOutcome, FillCallRefused>();
        answers.set(request.requestId, answer);
        const oldest = answers.keys().next();
        if (answers.size > ANSWERS_KEPT && oldest.done !== true) answers.delete(oldest.value);
        const call: FillCall = {
          tool: "fill_credential",
          requestId: request.requestId,
          caller: request.caller,
          arguments: request.arguments,
        };
        // A defect or an interruption reaches every waiter too, so none waits forever.
        yield* run(request, call).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => answers.delete(request.requestId))
              : Effect.void,
          ),
          Deferred.into(answer),
          Effect.forkIn(serverScope),
        );
        return yield* Deferred.await(answer);
      });

      return CredentialFills.of({ list, fillLogin });
    }),
  );

export const layer = make(TIMING);
