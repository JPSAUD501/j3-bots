// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accessAllows,
  type BotId,
  type Conflict,
  type CredentialFill,
  type FillField,
  FillOutcome,
  FillRefusal,
  type Secret,
  type SecretName,
  type SiteOrigin,
  siteOriginOf,
  WorkStepId,
} from "@j3-bots/contracts";
import type { TurnId } from "@j3-bots/engine-t3";
import type { BrowserPageState, BrowserTabRef } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { BotStore } from "../bots/BotStore.ts";
import type { BotSession } from "../bots/EngineSessions.ts";
import { TabAccess } from "../browser/TabAccess.ts";
import {
  type FillCall,
  type FillClaim,
  type TurnEnded,
  type TurnToolRefused,
  type TurnToolRetry,
  TurnTools,
} from "../tools/TurnTools.ts";
import { Observer } from "../turns/Observer.ts";
import { nameFromBot } from "./references.ts";
import { Secrets } from "./Secrets.ts";

// Filling a saved login into a bot's browser tab (`docs/architecture/server.md`,
// "Filling a login"). The call is first pinned to the engine's record of it in
// the caller's turn. Then the server holds the bot's current tab as its fill
// (`TabAccess`), so the bot's browser actions wait while it holds it, checks
// the page's committed address against the login's origins, and has the tab's
// host type the value into the focused field (`tab.fill`): the host types it
// only into a field that takes it, at the address the server checked, and
// takes a password the page kept out of the field again. Then the tab is given
// back. The bot never sees the value: its tool result, the work step, the log
// and the tab's text all lack it (`docs/architecture/security.md`, "Filling a
// login").

/** What a fill asks, from a bot's `fill_credential`. */
export interface FillRequest {
  /** The bridge's id for the call: a forward retried under it gets the first answer. */
  readonly requestId: string;
  readonly caller: BotSession;
  /** The login's name, or its reference, as `list_secrets` gives them. */
  readonly secret: string;
  readonly field: FillField;
  readonly submit: boolean;
  /** As the bridge received them: what the call is matched to the engine's record by. */
  readonly arguments: Schema.Json;
}

/** Why a fill was not even tried: the call is not one of the caller's turn. */
export type FillCallRefused = TurnEnded | TurnToolRefused | TurnToolRetry | Conflict;

export class CredentialFills extends Context.Service<
  CredentialFills,
  {
    readonly fillLogin: (request: FillRequest) => Effect.Effect<FillOutcome, FillCallRefused>;
  }
>()("@j3-bots/server/secrets/Fill/CredentialFills") {}

/** What a fill saw, for its step: the page's origin and the login, once known. */
interface Seen {
  origin: SiteOrigin | null;
  secret: Secret | null;
  /** The browser took what was typed. */
  typed: boolean;
}

/** A fill's call, pinned to its turn. */
type Claimed = Extract<FillClaim, { readonly _tag: "claimed" }>;

/** Why nothing was typed. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: FillRefusal }) {}

const refused = (reason: FillRefusal) => new Refused({ reason });

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

/** A page the server may type into: loaded, with no error, at its address. */
const loadedPage = (page: BrowserPageState) => {
  if (page.loading) return Effect.fail(refused("loading"));
  if (page.loadError !== null) return Effect.fail(refused("origin"));
  return Effect.succeed(page.url);
};

/**
 * The login named `name` among `secrets`, the bot's: `unknown-login` when
 * none is, `origin` when it is not saved for `origin`.
 */
const loginFor = (
  secrets: ReadonlyArray<Secret>,
  name: string,
  origin: SiteOrigin,
): Effect.Effect<Secret, Refused> => {
  const login = secrets.find((secret) => secret.name === name && secret.kind._tag === "login");
  if (login === undefined || login.kind._tag !== "login") {
    return Effect.fail(refused("unknown-login"));
  }
  if (!login.kind.origins.includes(origin)) return Effect.fail(refused("origin"));
  return Effect.succeed(login);
};

/** The most fills whose answer is kept for a forward retried while the server runs. */
const ANSWERS_KEPT = 256;

const WORDS: Record<FillOutcome["_tag"], string> = {
  filled: "Filled a saved login",
  refused: "Did not fill a saved login",
};

const encodeOutcome = Schema.encodeEffect(Schema.toCodecJson(FillOutcome));
const decodeOutcome = Schema.decodeUnknownEffect(Schema.toCodecJson(FillOutcome));

export const layer = Layer.effect(
  CredentialFills,
  Effect.gen(function* () {
    const bots = yield* BotStore;
    const secrets = yield* Secrets;
    const tabs = yield* TabAccess;
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
      { readonly turnId: TurnId; readonly tabs: Set<BrowserTabRef> }
    >();

    const refusedTabsOf = (request: FillRequest, turnId: TurnId) => {
      const current = refusals.get(request.caller.id);
      if (current !== undefined && current.turnId === turnId) return current.tabs;
      const fresh = { turnId, tabs: new Set<BrowserTabRef>() };
      refusals.set(request.caller.id, fresh);
      return fresh.tabs;
    };

    /**
     * The secrets the bot may use, while its browser is on: the grant of
     * each secret is the permission to fill it.
     */
    const usable = Effect.fnUntraced(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      if (Option.isNone(found) || !found.value.bot.browser) return yield* refused("no-access");
      return yield* secrets
        .usableBy(botId)
        .pipe(Effect.mapError((_: Conflict) => refused("unavailable")));
    });

    /** The fill itself, once the bot and the login are known to allow it. */
    const fillTab = Effect.fn("CredentialFills.fillTab")(function* (
      request: FillRequest,
      claim: Claimed,
      tab: BrowserTabRef,
      seen: Seen,
      name: SecretName,
    ) {
      const hold = yield* tabs
        .holdForFill(tab)
        .pipe(Effect.mapError((error) => refused(error.reason)));
      // Read from the tab's host now that the bot cannot act: its account
      // of where it is counts for nothing.
      const url = yield* loadedPage(hold.page);
      const origin = yield* pageOrigin(url);
      seen.origin = origin;
      const botId = request.caller.botId;
      const found = yield* loginFor(yield* usable(botId), name, origin);
      seen.secret = found;
      // The value comes with the login as it was when it was opened, so a
      // change to the login in between cannot pair a new value with the
      // origins it had before.
      const { value, secret } = yield* secrets
        .fillValue({ id: found.id, field: request.field })
        .pipe(
          Effect.catchTags({
            NotFound: () => Effect.fail(refused("no-value")),
            Conflict: () => Effect.fail(refused("unavailable")),
          }),
        );
      if (!accessAllows(secret.access, botId)) return yield* refused("unknown-login");
      yield* loginFor([secret], name, origin);
      // Again right before typing: what the operator may have changed since
      // the hold, the bot's switches, the login's bots, and the turn, which
      // they may have stopped while this fill waited for another; and the
      // person, whose input takes the tab at once.
      const still = yield* loginFor(yield* usable(botId), name, origin);
      if (still.id !== secret.id) return yield* refused("origin");
      if (!(yield* claim.stillOpen)) return yield* refused("stopped");
      if (yield* hold.preempted) return yield* refused("held");
      // The host types only at `url`: a page that moved since types nothing.
      const typed = yield* hold.host
        // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- the page host's fill, not an array's
        .fill({
          tab,
          field: request.field,
          value,
          url,
          submit: request.submit || request.field === "password",
        })
        .pipe(
          // Its reason only: the detail of a page's failure could quote the field.
          Effect.tapError((error) =>
            Effect.logWarning(
              "A browser host did not finish a login fill; the value may be in the field",
            ).pipe(Effect.annotateLogs({ reason: error.reason })),
          ),
          Effect.mapError(() => refused("unavailable")),
        );
      if (typed._tag === "refused") return yield* refused(typed.reason);
      seen.typed = true;
      return { submitted: typed.submitted };
    }, Effect.scoped);

    const attempt = Effect.fn("CredentialFills.attempt")(function* (
      request: FillRequest,
      claim: Claimed,
      seen: Seen,
    ) {
      const name = Option.getOrNull(nameFromBot(request.secret));
      if (name === null) return yield* refused("unknown-login");
      const named = (yield* usable(request.caller.botId)).filter(
        (secret) => secret.name === name && secret.kind._tag === "login",
      );
      if (named.length === 0) return yield* refused("unknown-login");
      const current = yield* tabs.toolTab(request.caller.botId, undefined);
      if (Option.isNone(current)) return yield* refused("no-tab");
      const tab = current.value.ref;
      const refusedTabs = refusedTabsOf(request, claim.turnId);
      if (refusedTabs.has(tab)) return yield* refused("refused-before");
      const filled =
        current.value.heldBy?.kind === "person"
          ? Effect.fail(refused("held"))
          : fillTab(request, claim, tab, seen, name);
      return yield* filled.pipe(
        // Once the tab was looked at, a refusal holds for the tab and the
        // turn. Secrets that cannot be read, a browser that did not answer, a person
        // holding the tab or a stopped turn is no refusal of the page.
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              error._tag === "Refused" &&
              error.reason !== "unavailable" &&
              error.reason !== "held" &&
              error.reason !== "stopped"
            ) {
              refusedTabs.add(tab);
            }
          }),
        ),
      );
    });

    /** Records the fill as a step of the caller's running turn, and in the log, without a value. */
    const record = Effect.fn("CredentialFills.record")(function* (
      request: FillRequest,
      outcome: FillOutcome,
      seen: Seen,
      startedAt: DateTime.Utc,
    ) {
      const fill: CredentialFill = {
        name: request.secret,
        secretId: seen.secret?.id ?? null,
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
          secretId: seen.secret?.id ?? null,
          field: request.field,
          outcome: outcome._tag,
          reason: outcome._tag === "refused" ? outcome.reason : null,
        }),
      );
    });

    /** A fill claimed for `turnId`, run, recorded, and its answer stored for its call. */
    const run = Effect.fn("CredentialFills.run")(function* (request: FillRequest, call: FillCall) {
      const claim = yield* turnTools.claimFill(call);
      if (claim._tag === "stored") return yield* decodeOutcome(claim.result).pipe(Effect.orDie);
      const startedAt = yield* DateTime.now;
      const seen: Seen = { origin: null, secret: null, typed: false };
      const outcome = yield* attempt(request, claim, seen).pipe(
        Effect.map(({ submitted }): FillOutcome => ({ _tag: "filled", submitted })),
        Effect.catchTags({
          Refused: (error) =>
            Effect.succeed<FillOutcome>({ _tag: "refused", reason: error.reason }),
        }),
        lock.withPermits(1),
      );
      yield* record(request, outcome, seen, startedAt);
      // Once the tab is given back and the fill answered, where the login
      // was used last: a write that fails changes neither.
      const { secret, origin } = seen;
      if (seen.typed && secret !== null && origin !== null) {
        yield* secrets
          .filled({
            id: secret.id,
            botId: request.caller.botId,
            use: { _tag: "browser", origin },
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Where a login was used last could not be recorded").pipe(
                Effect.annotateLogs({ secretId: secret.id }),
              ),
            ),
          );
      }
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
          Exit.isFailure(exit) ? Effect.sync(() => answers.delete(request.requestId)) : Effect.void,
        ),
        Deferred.into(answer),
        Effect.forkIn(serverScope),
      );
      return yield* Deferred.await(answer);
    });

    return CredentialFills.of({ fillLogin });
  }),
);
