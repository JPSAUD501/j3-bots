// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { FakePageHost } from "@j3-bots/browser/testing";
import {
  type BrowserFillField,
  type BrowserTabRef,
  type FillOutcome,
  type SecretDraft,
  SecretId,
  SecretName,
  SiteOrigin,
  type WorkStep,
} from "@j3-bots/contracts";
import type { SessionId, TurnId } from "@j3-bots/engine-t3";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import { FILL_NOTES } from "@j3-bots/prompts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { EngineSessions } from "../bots/EngineSessions.ts";
import { Browser } from "../browser/Browser.ts";
import { botOpens, operatorDevice, TestServerBrowser } from "../testing/browser.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  conversation,
  createBot,
  engineSession,
  finishRunning,
  nextTurn,
  sendToBot,
  turnEnded,
  until,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { CredentialFills, type FillRequest } from "./Fill.ts";
import { Secrets } from "./Secrets.ts";

const USERNAME = "username-value@example.com";
const PASSWORD = "login-password-value";
/** RFC 6238's SHA-1 seed, "12345678901234567890", in base32, with eight-digit codes. */
const TOTP = "otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
const LOGIN_URL = "https://example.com/login";
const LOGIN_ID = SecretId.make("sec_aaaaaaaaaaaaaaaa");
/** How the bot names the login: by its reference, as `list_secrets` gives it. */
const REFERENCE = "secret:example";

const draft = (origins: ReadonlyArray<string>): SecretDraft => ({
  _tag: "login",
  origins: [
    SiteOrigin.make(origins[0] ?? ""),
    ...origins.slice(1).map((origin) => SiteOrigin.make(origin)),
  ],
  username: Redacted.make(USERNAME),
  password: Redacted.make(PASSWORD),
  totp: Redacted.make(TOTP),
});

const domain = TestDomain.layer;

/**
 * A bot with its browser on, the login `example` saved for `origins` and
 * usable by it, its own tab open at `url` in the server's browser with the
 * focus on `focus`, and a turn running.
 */
const scene = (input: {
  readonly url: string;
  readonly origins?: ReadonlyArray<string>;
  readonly browserAccess?: boolean;
  readonly allowed?: boolean;
  readonly focus?: BrowserFillField | "other";
}) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { browser: input.browserAccess ?? true },
    });
    const session = yield* engineSession(bot.id);
    yield* (yield* Secrets).add({
      id: LOGIN_ID,
      name: SecretName.make("example"),
      draft: draft(input.origins ?? ["https://example.com"]),
      access: { _tag: "bots", botIds: (input.allowed ?? true) ? [bot.id] : [] },
    });
    const tab = yield* botOpens(bot.id, input.url);
    const host = yield* (yield* TestServerBrowser).running;
    const focus = (field: BrowserFillField | "other") =>
      host.serve(input.url, { title: "Sign in", tree: "", focus: field });
    yield* focus(input.focus ?? "password");
    const caller = Option.getOrThrow(yield* (yield* EngineSessions).ofEngineSession(session));
    yield* sendToBot(bot.id, "Sign in to Example.");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, tab, host, focus, caller, turnId };
  });

let requests = 0;

/** A bot's `fill_credential` call, as the engine records it in the turn and the bridge forwards it. */
const request = (
  at: {
    readonly caller: FillRequest["caller"];
    readonly session: SessionId;
    readonly turnId: TurnId;
  },
  field: FillRequest["field"],
  submit?: boolean,
  secret: string = REFERENCE,
) =>
  Effect.gen(function* () {
    const input = { secret, field, ...(submit === undefined ? {} : { submit }) };
    yield* (yield* TestEngineControl).toolCall({
      sessionId: at.session,
      turnId: at.turnId,
      tool: "fill_credential",
      input,
      recorded: "now",
    });
    return {
      requestId: `fill-${++requests}`,
      caller: at.caller,
      secret,
      field,
      submit: submit ?? false,
      arguments: input,
    } satisfies FillRequest;
  });

const fill = (made: Effect.Effect<FillRequest, never, TestEngineControl>) =>
  Effect.gen(function* () {
    return yield* (yield* CredentialFills).fillLogin(yield* made);
  });

/** What the host typed, in order, with the value and whether Enter followed. */
const typed = (host: FakePageHost) =>
  Effect.map(host.fills, (fills) =>
    fills.map((one) => ({
      field: one.field,
      value: Redacted.value(one.value),
      submitted: one.submitted,
    })),
  );

/** How many times the host was asked to type. */
const fillCalls = (host: FakePageHost) =>
  Effect.map(host.calls, (calls) => calls.filter((call) => call.call === "tab.fill").length);

/** The host says its tab is now as `change` says, as a page it runs reports itself. */
const reports = (
  host: FakePageHost,
  tab: BrowserTabRef,
  change: { readonly url?: string; readonly loading?: boolean },
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const page = Option.getOrThrow(yield* browser.handsOf(tab)).page;
    const next = { ...page, ...change };
    yield* host.emit({ type: "tab.changed", page: next });
    yield* until(
      browser
        .handsOf(tab)
        .pipe(
          Effect.map((hands) =>
            Option.exists(
              hands,
              ({ page: now }) => now.url === next.url && now.loading === next.loading,
            ),
          ),
        ),
    );
  });

/** Nobody holds the tab: the fill gave it back. */
const givenBack = (tab: BrowserTabRef) =>
  Effect.gen(function* () {
    const hands = Option.getOrThrow(yield* (yield* Browser).handsOf(tab));
    assert.isNull((yield* hands.control.state).holder);
  });

describe("filling a saved login", () => {
  it.effect(
    "has the host type the password where the focus is, submit it, and give the tab back",
    () =>
      Effect.gen(function* () {
        const at = yield* scene({ url: LOGIN_URL });
        // Asked without `submit`: a password is submitted anyway.
        assert.deepStrictEqual(yield* fill(request(at, "password", false)), {
          _tag: "filled",
          submitted: true,
        });
        assert.deepStrictEqual(yield* typed(at.host), [
          { field: "password", value: PASSWORD, submitted: true },
        ]);
        yield* givenBack(at.tab);
        // Settings says where the login was used last.
        const [login] = yield* (yield* Secrets).list;
        assert.deepStrictEqual(
          login?.lastUse === null ? null : [login?.lastUse?.botId, login?.lastUse?.use],
          [at.bot.id, { _tag: "browser", origin: SiteOrigin.make("https://example.com") }],
        );
      }).pipe(Effect.provide(domain)),
  );

  it.effect("types a user name alone, and has Enter pressed only when asked", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, focus: "username" });
      assert.deepStrictEqual(yield* fill(request(at, "username")), {
        _tag: "filled",
        submitted: false,
      });
      // Named by its name, as by its reference.
      assert.deepStrictEqual(yield* fill(request(at, "username", true, "example")), {
        _tag: "filled",
        submitted: true,
      });
      assert.deepStrictEqual(yield* typed(at.host), [
        { field: "username", value: USERNAME, submitted: false },
        { field: "username", value: USERNAME, submitted: true },
      ]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types the one-time code of the moment, as RFC 6238 gives it", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, focus: "totp" });
      // The seed's codes at T = 0 s (counter 0, RFC 4226 Appendix D, to eight
      // digits) and T = 59 s (RFC 6238 Appendix B); `totp.test.ts` has the rest.
      yield* TestClock.setTime(0);
      assert.deepStrictEqual(yield* fill(request(at, "totp")), {
        _tag: "filled",
        submitted: false,
      });
      yield* TestClock.setTime(59_000);
      yield* fill(request(at, "totp"));
      assert.deepStrictEqual(
        (yield* typed(at.host)).map((one) => one.value),
        ["84755224", "94287082"],
      );
    }).pipe(Effect.provide(domain)),
  );

  it.effect("fills over plain http only on this computer", () =>
    Effect.gen(function* () {
      const at = yield* scene({
        url: "http://127.0.0.1:8080/login",
        origins: ["http://127.0.0.1:8080"],
        focus: "username",
      });
      assert.deepStrictEqual(yield* fill(request(at, "username")), {
        _tag: "filled",
        submitted: false,
      });
      assert.deepStrictEqual(
        (yield* typed(at.host)).map((one) => one.value),
        [USERNAME],
      );
    }).pipe(Effect.provide(domain)),
  );

  it.effect("answers a forward retried under the same id once, with one fill", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, focus: "username" });
      const made = yield* request(at, "username");
      const fills = yield* CredentialFills;
      const first = yield* fills.fillLogin(made);
      assert.deepStrictEqual(yield* fills.fillLogin(made), first);
      assert.strictEqual(yield* fillCalls(at.host), 1);
    }).pipe(Effect.provide(domain)),
  );
});

describe("a fill refused by the page", () => {
  const refusedAt: ReadonlyArray<readonly [string, string, FillOutcome]> = [
    ["a lookalike name", "https://examp1e.com/login", refusal("origin")],
    ["the site's name inside another", "https://example.com.evil.net/login", refusal("origin")],
    // `exämple.com`: the URL parser gives its punycode, which is not `example.com`.
    ["a lookalike in another script", "https://exämple.com/login", refusal("origin")],
    ["a subdomain the login does not name", "https://accounts.example.com/", refusal("origin")],
    ["another port", "https://example.com:8443/login", refusal("origin")],
    ["plain http on another computer", "http://example.com/login", refusal("insecure")],
  ];

  for (const [what, url, expected] of refusedAt) {
    it.effect(`refuses ${what}, typing nothing`, () =>
      Effect.gen(function* () {
        const at = yield* scene({ url });
        assert.deepStrictEqual(yield* fill(request(at, "password")), expected);
        assert.strictEqual(yield* fillCalls(at.host), 0);
        yield* givenBack(at.tab);
      }).pipe(Effect.provide(domain)),
    );
  }

  // Pages the host reports itself at, which no tab is opened at.
  const reportedAt: ReadonlyArray<readonly [string, string]> = [
    ["a page that is no web page", "file:///etc/passwd"],
    // Its origin is the address inside it, but the page is whatever made the blob.
    ["a blob page of the login's origin", "blob:https://example.com/1f0c"],
  ];

  for (const [what, url] of reportedAt) {
    it.effect(`refuses ${what}, typing nothing`, () =>
      Effect.gen(function* () {
        const at = yield* scene({ url: LOGIN_URL });
        yield* reports(at.host, at.tab, { url });
        assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("origin"));
        assert.strictEqual(yield* fillCalls(at.host), 0);
      }).pipe(Effect.provide(domain)),
    );
  }

  it.effect("refuses a page still loading", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      yield* reports(at.host, at.tab, { loading: true });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("loading"));
      assert.strictEqual(yield* fillCalls(at.host), 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("passes on the host's refusal of a page that moved, typing nothing", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      // The server last heard of another page of the same origin; the host is
      // still at the sign-in, so it types nowhere but where the server checked.
      yield* reports(at.host, at.tab, { url: "https://example.com/other" });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("navigated"));
      assert.deepStrictEqual(yield* typed(at.host), []);
      // Nothing was typed, so the login was not used.
      const [login] = yield* (yield* Secrets).list;
      assert.isNull(login?.lastUse);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("passes on the host's refusal when the focus is on no field the value fits", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, focus: "other" });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("field"));
      assert.deepStrictEqual(yield* typed(at.host), []);
      yield* givenBack(at.tab);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("takes no other fill on that tab in the same turn, whatever it asks", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: "https://evil.example.net/" });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("origin"));
      assert.deepStrictEqual(yield* fill(request(at, "username")), refusal("refused-before"));

      // The bot's next turn looks at the page again.
      yield* finishRunning(at.bot.id);
      yield* turnEnded(at.bot.id);
      yield* sendToBot(at.bot.id, "Try again.");
      const turnId = yield* nextTurn(at.bot.id, at.turnId);
      assert.deepStrictEqual(
        yield* fill(request({ ...at, turnId }, "username")),
        refusal("origin"),
      );
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a tab a person holds, and fills it once they gave it back", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const phone = yield* operatorDevice("Phone");
      const control = Option.getOrThrow(yield* (yield* Browser).handsOf(at.tab)).control;
      assert.isTrue(yield* control.waitForMe(phone));
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("held"));
      assert.strictEqual(yield* fillCalls(at.host), 0);

      // A person holding the tab is no refusal of the page, so the next is no `refused-before`.
      yield* control.release(phone, false);
      assert.deepStrictEqual(yield* fill(request(at, "password")), {
        _tag: "filled",
        submitted: true,
      });
    }).pipe(Effect.provide(domain)),
  );
});

describe("a fill refused before the page", () => {
  it.effect("refuses a login the bot may not use, and a secret that is no login", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, allowed: false });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("unknown-login"));
      yield* (yield* Secrets).add({
        id: SecretId.make("sec_bbbbbbbbbbbbbbbb"),
        name: SecretName.make("weather-api"),
        draft: { _tag: "value", value: Redacted.make("weather-token-value") },
        access: { _tag: "every-bot" },
      });
      assert.deepStrictEqual(
        yield* fill(request(at, "password", false, "secret:weather-api")),
        refusal("unknown-login"),
      );
      assert.strictEqual(yield* fillCalls(at.host), 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a bot whose browser is off", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, browserAccess: false });
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("no-access"));
      assert.strictEqual(yield* fillCalls(at.host), 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a bot with no tab", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      yield* (yield* Browser).close(at.tab);
      assert.deepStrictEqual(yield* fill(request(at, "password")), refusal("no-tab"));
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types nothing for a turn that ended while the fill waited for the tab", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const control = Option.getOrThrow(yield* (yield* Browser).handsOf(at.tab)).control;
      // A browser step of the bot's runs on the tab: the fill waits for it to finish.
      const gate = yield* Deferred.make<void>();
      const acting = yield* control.act(at.bot.id, Deferred.await(gate)).pipe(Effect.forkChild);
      yield* until(control.state.pipe(Effect.map((state) => state.acting !== null)));
      const made = yield* request(at, "password");
      const running = yield* (yield* CredentialFills).fillLogin(made).pipe(Effect.forkChild);
      // Claimed for its turn, it waits on the tab.
      const sql = yield* SqlClient.SqlClient;
      yield* until(
        sql`SELECT 1 FROM tool_calls WHERE id = ${made.requestId}`.pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length > 0),
        ),
      );
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: at.session,
        turnId: at.turnId,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(at.bot.id);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(acting);

      assert.deepStrictEqual(yield* Fiber.join(running), refusal("stopped"));
      assert.strictEqual(yield* fillCalls(at.host), 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("fills nothing for a call the bot's turn did not make", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const recorded = yield* request(at, "username");
      // The same request, with arguments the engine has no call for.
      const error = yield* (yield* CredentialFills)
        .fillLogin({
          ...recorded,
          field: "password",
          arguments: { secret: REFERENCE, field: "password" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "TurnEnded");
      assert.strictEqual(yield* fillCalls(at.host), 0);
    }).pipe(Effect.provide(domain)),
  );
});

/** Every line logged while the test runs, at any level, as JSON. */
const logged: Array<string> = [];
const recordLogs = Layer.merge(
  Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      logged.push(line);
    }),
  ]),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

it.effect(
  "keeps every value out of the tool's answers, the work fold, the entries and the log",
  () =>
    Effect.gen(function* () {
      const { bot, session, turnId, focus } = yield* scene({ url: LOGIN_URL });
      const tools = yield* BotTools;
      const control = yield* TestEngineControl;
      const answers: Array<unknown> = [];
      const call = (tool: string, input: Schema.Json) =>
        control.toolCall({ sessionId: session, turnId, tool, input, recorded: "now" }).pipe(
          Effect.andThen(
            tools
              .call({
                requestId: `call-${++requests}`,
                sessionId: session,
                tool,
                arguments: input,
              })
              .pipe(Effect.tap((answer) => Effect.sync(() => answers.push(answer)))),
          ),
        );

      yield* call("list_secrets", {});
      for (const field of ["username", "password", "totp"] as const) {
        yield* focus(field);
        yield* call("fill_credential", { secret: REFERENCE, field });
      }

      const fold = yield* awaitEntry(bot.id, "work-fold");
      const steps = yield* (yield* WorkSteps).follow(fold.id).pipe(
        Stream.runHead,
        Effect.orDie,
        Effect.map((frame) =>
          Option.isSome(frame) && frame.value._tag === "snapshot" ? frame.value.steps : [],
        ),
      );
      const fillsShown = steps.flatMap((step: WorkStep) =>
        step.fill === undefined ? [] : [step.fill],
      );
      assert.deepStrictEqual(
        fillsShown.map((shown): ReadonlyArray<string | null> => [
          shown.field,
          shown.origin,
          shown.outcome._tag,
        ]),
        [
          ["username", "https://example.com", "filled"],
          ["password", "https://example.com", "filled"],
          ["totp", "https://example.com", "filled"],
        ],
      );
      assert.deepStrictEqual(answers.slice(0, 2), [
        {
          _tag: "result",
          value: {
            status: "listed",
            secrets: [{ reference: REFERENCE, kind: "login", origins: ["https://example.com"] }],
            note: FILL_NOTES.listed,
          },
        },
        {
          _tag: "result",
          value: {
            status: "filled",
            submitted: false,
            note: FILL_NOTES.filled,
          },
        },
      ]);

      const said = JSON.stringify([answers, steps, yield* conversation(bot.id), logged]);
      // The code the seed gives at the test clock's start, counter 0 (RFC 4226, Appendix D).
      for (const value of [USERNAME, PASSWORD, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "84755224"]) {
        assert.notInclude(said, value);
      }
      assert.isTrue(logged.some((line) => line.includes("A saved login was filled")));
    }).pipe(Effect.provide(Layer.merge(domain, recordLogs))),
);

function refusal(
  reason: Extract<FillOutcome, { readonly _tag: "refused" }>["reason"],
): FillOutcome {
  return { _tag: "refused", reason };
}
