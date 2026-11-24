// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  type BrowserInput,
  type CredentialDraft,
  CredentialId,
  type FillOutcome,
  Label,
  SiteOrigin,
  type WorkStep,
} from "@j3-bots/contracts";
import { EngineTabId, type SessionId, type TurnId } from "@j3-bots/engine-t3";
import { type FakeViewer, TestBrowserControl, TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Bots } from "../bots/Bots.ts";
import { BrowserTabs } from "../browser/BrowserTabs.ts";
import { Devices } from "../devices/Devices.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  conversation,
  createBot,
  engineSession,
  eventually,
  mainSessionId,
  finishRunning,
  nextTurn,
  sendToBot,
  turnEnded,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { CredentialFills, type FillRequest } from "./Fill.ts";
import { Vault } from "./Vault.ts";

const MASTER = Redacted.make("master-password-value");
const USERNAME = "username-value@example.com";
const PASSWORD = "login-password-value";
/** RFC 6238's SHA-1 seed, "12345678901234567890", in base32, with eight-digit codes. */
const TOTP = "otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
const LOGIN_URL = "https://example.com/login";
const LOGIN_ID = CredentialId.make("cred_aaaaaaaaaaaaaaaa");

const draft = (origins: ReadonlyArray<string>): CredentialDraft => ({
  name: Label.make("Example"),
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
 * A bot with its browser and its vault access on, the login `Example` saved
 * for `origins` and allowed to it, one tab open at `url`, and a turn running.
 */
const scene = (input: {
  readonly url: string;
  readonly origins?: ReadonlyArray<string>;
  readonly vaultAccess?: boolean;
  readonly browserAccess?: boolean;
  readonly allowed?: boolean;
}) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    yield* (yield* Bots).update({
      commandId: command(),
      botId: bot.id,
      changes: { vault: input.vaultAccess ?? true, browser: input.browserAccess ?? true },
    });
    const session = yield* engineSession(bot.id);
    const vault = yield* Vault;
    yield* vault.setup(MASTER);
    yield* vault.save({
      id: LOGIN_ID,
      draft: draft(input.origins ?? ["https://example.com"]),
      allowedBots: (input.allowed ?? true) ? [bot.id] : [],
    });
    const browser = yield* TestBrowserControl;
    const tab = EngineTabId.make("tab-1");
    yield* browser.setTabs([
      {
        id: tab,
        sessionId: session,
        url: input.url,
        title: "Sign in",
        loading: false,
        activeAt: 1,
      },
    ]);
    const tabs = yield* BrowserTabs;
    yield* eventually(tabs.frontOf(session));
    const caller = { id: yield* mainSessionId(bot.id), botId: bot.id };
    yield* sendToBot(bot.id, "Sign in to Example.");
    const turnId = yield* nextTurn(bot.id);
    return { bot, session, browser, tab, caller, turnId };
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
) =>
  Effect.gen(function* () {
    const input = { credential: "Example", field, ...(submit === undefined ? {} : { submit }) };
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
      engineSessionId: at.session,
      credential: "Example",
      field,
      submit: submit ?? false,
      arguments: input,
    } satisfies FillRequest;
  });

/** Answers the server's take of the tab as the engine does once it holds it. */
const grantTake = (viewer: FakeViewer) =>
  Effect.gen(function* () {
    const first = yield* viewer.nextInput;
    assert.deepStrictEqual(first, { type: "take" });
    yield* viewer.emit({ _tag: "control", controller: "this-viewer", generation: 1, dialog: null });
  });

/** Starts a fill, holding the tab for it as the engine would, and answers it with its viewer. */
const fillHeld = (fill: Effect.Effect<FillRequest, never, TestEngineControl>) =>
  Effect.gen(function* () {
    const browser = yield* TestBrowserControl;
    const fills = yield* CredentialFills;
    const running = yield* fills.fillLogin(yield* fill).pipe(Effect.forkChild);
    const viewer = yield* browser.nextViewer;
    yield* grantTake(viewer);
    return { running, viewer };
  });

/** Moves the test clock on, a second at a time, until `running` ends: the fill's waits pass. */
const runOut = <A, E>(running: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (running.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
    }
    return yield* Fiber.join(running);
  });

const typed = (inputs: ReadonlyArray<BrowserInput>) =>
  inputs.flatMap((input) => (input.type === "text" ? [input.text] : []));

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

const keys = (inputs: ReadonlyArray<BrowserInput>) =>
  inputs.flatMap((input) => (input.type === "key" ? [`${input.key} ${input.action}`] : []));

const loaded = (url: string) => ({ _tag: "loaded", url }) as const;

/** Fills `fill` where no viewer is opened: the answer comes before the page. */
const fillUnheld = (fill: Effect.Effect<FillRequest, never, TestEngineControl>) =>
  Effect.gen(function* () {
    const fills = yield* CredentialFills;
    return yield* fills.fillLogin(yield* fill);
  });

const PROBE = { type: "probe", x: 0, y: 0 } as const;

describe("filling a saved login", () => {
  it.effect("types the password while it holds the tab, presses Enter, then gives it back", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      // Checked after the take and again before typing; then the page loads the next.
      yield* at.browser.scriptReads([
        loaded(LOGIN_URL),
        loaded(LOGIN_URL),
        { _tag: "loading", url: "https://example.com/home" },
        loaded("https://example.com/home"),
      ]);
      const { running, viewer } = yield* fillHeld(request(at, "password"));

      assert.deepStrictEqual(yield* runOut(running), { _tag: "filled", submitted: true });
      yield* viewer.released;
      // Enter within the hold, and the tab given back only once the engine
      // answered a probe sent after them: the input before it has run.
      assert.deepStrictEqual(yield* viewer.inputs, [
        { type: "take" },
        { type: "text", text: PASSWORD },
        ENTER_DOWN,
        ENTER_UP,
        PROBE,
        { type: "release" },
      ]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("submits a password filled without `submit`, and clears it on a page that stays", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const { running, viewer } = yield* fillHeld(request(at, "password", false));

      // The page never moves on: the server waits it out, then clears the field.
      assert.deepStrictEqual(yield* runOut(running), { _tag: "filled", submitted: true });
      const pressed = keys(yield* viewer.inputs);
      assert.deepStrictEqual(pressed.slice(0, 2), ["Enter down", "Enter up"]);
      assert.deepStrictEqual(
        pressed.slice(2),
        Array.from(PASSWORD).flatMap(() => ["Backspace down", "Backspace up"]),
      );
      assert.deepStrictEqual((yield* viewer.inputs).slice(-2), [PROBE, { type: "release" }]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("clears a password on a page that only changed its address", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      // `history.pushState` after a failed sign-in: loaded at another address, the same document.
      yield* at.browser.scriptReads([
        loaded(LOGIN_URL),
        loaded(LOGIN_URL),
        loaded(`${LOGIN_URL}?error=1`),
      ]);
      const { running, viewer } = yield* fillHeld(request(at, "password"));

      assert.deepStrictEqual(yield* runOut(running), { _tag: "filled", submitted: true });
      assert.strictEqual(
        keys(yield* viewer.inputs).filter((key) => key === "Backspace down").length,
        Array.from(PASSWORD).length,
      );
    }).pipe(Effect.provide(domain)),
  );

  it.effect("clears a password on a page that loaded at its own address again", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      // A sign-in that failed and showed the form again, or one answered with no new document.
      yield* at.browser.scriptReads([
        loaded(LOGIN_URL),
        loaded(LOGIN_URL),
        { _tag: "loading", url: LOGIN_URL },
      ]);
      const { running, viewer } = yield* fillHeld(request(at, "password"));

      assert.deepStrictEqual(yield* runOut(running), { _tag: "filled", submitted: true });
      assert.strictEqual(
        keys(yield* viewer.inputs).filter((key) => key === "Backspace down").length,
        Array.from(PASSWORD).length,
      );
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types a user name alone, and presses Enter only when asked", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const first = yield* fillHeld(request(at, "username"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), {
        _tag: "filled",
        submitted: false,
      });
      const inputs = yield* first.viewer.inputs;
      assert.deepStrictEqual(typed(inputs), [USERNAME]);
      assert.deepStrictEqual(keys(inputs), []);

      const second = yield* fillHeld(request(at, "username", true));
      assert.deepStrictEqual(yield* Fiber.join(second.running), {
        _tag: "filled",
        submitted: true,
      });
      assert.deepStrictEqual(keys(yield* second.viewer.inputs), ["Enter down", "Enter up"]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types the one-time code of the moment, as RFC 6238 gives it", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      // The seed's codes at T = 0 s (counter 0, RFC 4226 Appendix D, to eight
      // digits) and T = 59 s (RFC 6238 Appendix B); `totp.test.ts` has the rest.
      for (const [seconds, code] of [
        [0, "84755224"],
        [59, "94287082"],
      ] as const) {
        yield* TestClock.setTime(seconds * 1000);
        const { running, viewer } = yield* fillHeld(request(at, "totp"));
        assert.deepStrictEqual(yield* Fiber.join(running), { _tag: "filled", submitted: false });
        assert.deepStrictEqual(typed(yield* viewer.inputs), [code]);
      }
    }).pipe(Effect.provide(domain)),
  );

  it.effect("fills over plain http only on this computer", () =>
    Effect.gen(function* () {
      const at = yield* scene({
        url: "http://127.0.0.1:8080/login",
        origins: ["http://127.0.0.1:8080"],
      });
      const { running, viewer } = yield* fillHeld(request(at, "username"));
      assert.deepStrictEqual(yield* Fiber.join(running), { _tag: "filled", submitted: false });
      assert.deepStrictEqual(typed(yield* viewer.inputs), [USERNAME]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("answers a forward retried under the same id once, with one fill", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const fill = yield* request(at, "username");
      const { running } = yield* fillHeld(Effect.succeed(fill));
      const first = yield* Fiber.join(running);
      const opened = yield* at.browser.opens;

      assert.deepStrictEqual(yield* (yield* CredentialFills).fillLogin(fill), first);
      assert.strictEqual(yield* at.browser.opens, opened);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("says the browser did not confirm the typing when the engine never answers", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      yield* at.browser.answerProbes(false);
      const { running, viewer } = yield* fillHeld(request(at, "username"));

      assert.deepStrictEqual(yield* runOut(running), refusal("unavailable"));
      yield* viewer.released;
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
    ["a page that is no web page", "file:///etc/passwd", refusal("origin")],
    // Its origin is the address inside it, but the page is whatever made the blob.
    ["a blob page of the login's origin", "blob:https://example.com/1f0c", refusal("origin")],
  ];

  for (const [what, url, expected] of refusedAt) {
    it.effect(`refuses ${what}, typing nothing`, () =>
      Effect.gen(function* () {
        const at = yield* scene({ url });
        const { running, viewer } = yield* fillHeld(request(at, "password"));
        assert.deepStrictEqual(yield* Fiber.join(running), expected);
        yield* viewer.released;
        assert.deepStrictEqual(typed(yield* viewer.inputs), []);
      }).pipe(Effect.provide(domain)),
    );
  }

  it.effect("refuses a page still loading, and one that moves while the tab is held", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      yield* at.browser.scriptReads([{ _tag: "loading", url: LOGIN_URL }]);
      const first = yield* fillHeld(request(at, "password"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), refusal("loading"));

      // The same origin, another page: still a move.
      yield* at.browser.scriptReads([loaded(LOGIN_URL), loaded("https://example.com/other")]);
      const tab = EngineTabId.make("tab-2");
      yield* at.browser.setTabs([
        {
          id: tab,
          sessionId: at.session,
          url: LOGIN_URL,
          title: "Sign in",
          loading: false,
          activeAt: 2,
        },
      ]);
      const tabs = yield* BrowserTabs;
      yield* eventually(
        tabs.frontOf(at.session).pipe(Effect.map(Option.filter((front) => front.tab.id === tab))),
      );
      const second = yield* fillHeld(request(at, "password"));
      assert.deepStrictEqual(yield* Fiber.join(second.running), refusal("navigated"));
      assert.deepStrictEqual(typed(yield* second.viewer.inputs), []);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("takes no other fill on that tab in the same turn, whatever it asks", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: "https://evil.example.net/" });
      const first = yield* fillHeld(request(at, "password"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), refusal("origin"));
      const opened = yield* at.browser.opens;

      assert.deepStrictEqual(yield* fillUnheld(request(at, "username")), refusal("refused-before"));
      assert.strictEqual(yield* at.browser.opens, opened);

      // The bot's next turn looks at the page again.
      yield* finishRunning(at.bot.id);
      yield* turnEnded(at.bot.id);
      yield* sendToBot(at.bot.id, "Try again.");
      const turnId = yield* nextTurn(at.bot.id, at.turnId);
      const next = yield* fillHeld(request({ ...at, turnId }, "username"));
      assert.deepStrictEqual(yield* Fiber.join(next.running), refusal("origin"));
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a tab a person holds, from a device or as the engine says", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const tabs = yield* BrowserTabs;

      // The engine answers the take: another viewer has it.
      const running = yield* (yield* CredentialFills)
        .fillLogin(yield* request(at, "password"))
        .pipe(Effect.forkChild);
      const viewer = yield* at.browser.nextViewer;
      assert.deepStrictEqual(yield* viewer.nextInput, { type: "take" });
      yield* viewer.emit({
        _tag: "control",
        controller: "another-viewer",
        generation: 1,
        dialog: null,
      });
      assert.deepStrictEqual(yield* runOut(running), refusal("held"));

      // A device holds it: no viewer is opened at all. A person holding the
      // tab is no refusal of the page, so this is not `refused-before`.
      const opened = yield* at.browser.opens;
      yield* tabs.holding(at.tab, yield* pairDevice, true);
      assert.deepStrictEqual(yield* fillUnheld(request(at, "password")), refusal("held"));
      assert.strictEqual(yield* at.browser.opens, opened);
    }).pipe(Effect.provide(domain)),
  );
});

describe("a fill refused before the page", () => {
  it.effect("refuses a bot without vault access, and a login not allowed to it", () =>
    Effect.gen(function* () {
      const off = yield* scene({ url: LOGIN_URL, vaultAccess: false });
      const fills = yield* CredentialFills;
      assert.deepStrictEqual(yield* fillUnheld(request(off, "password")), refusal("no-access"));
      assert.deepStrictEqual(yield* fills.list(off.bot.id), {
        _tag: "refused",
        reason: "no-access",
      });
      yield* (yield* Bots).update({
        commandId: command(),
        botId: off.bot.id,
        changes: { vault: true },
      });
      yield* (yield* Vault).setAllowedBots(LOGIN_ID, []);
      assert.deepStrictEqual(yield* fillUnheld(request(off, "password")), refusal("unknown-login"));
      assert.deepStrictEqual(yield* fills.list(off.bot.id), { _tag: "listed", credentials: [] });
      assert.strictEqual(yield* off.browser.opens, 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a bot whose browser is off, though its vault access is on", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL, browserAccess: false });
      assert.deepStrictEqual(yield* fillUnheld(request(at, "password")), refusal("no-access"));
      assert.deepStrictEqual(yield* (yield* CredentialFills).list(at.bot.id), {
        _tag: "refused",
        reason: "no-access",
      });
      assert.strictEqual(yield* at.browser.opens, 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses when the operator takes vault access away while the take waits", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const running = yield* (yield* CredentialFills)
        .fillLogin(yield* request(at, "password"))
        .pipe(Effect.forkChild);
      const viewer = yield* at.browser.nextViewer;
      assert.deepStrictEqual(yield* viewer.nextInput, { type: "take" });
      yield* (yield* Bots).update({
        commandId: command(),
        botId: at.bot.id,
        changes: { vault: false },
      });
      yield* viewer.emit({
        _tag: "control",
        controller: "this-viewer",
        generation: 1,
        dialog: null,
      });

      assert.deepStrictEqual(yield* Fiber.join(running), refusal("no-access"));
      yield* viewer.released;
      assert.deepStrictEqual(typed(yield* viewer.inputs), []);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types nothing for a turn that ended while the take waited", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      const running = yield* (yield* CredentialFills)
        .fillLogin(yield* request(at, "password"))
        .pipe(Effect.forkChild);
      const viewer = yield* at.browser.nextViewer;
      assert.deepStrictEqual(yield* viewer.nextInput, { type: "take" });
      yield* (yield* TestEngineControl).finishTurn({
        sessionId: at.session,
        turnId: at.turnId,
        outcome: { _tag: "completed" },
      });
      yield* turnEnded(at.bot.id);
      yield* viewer.emit({
        _tag: "control",
        controller: "this-viewer",
        generation: 1,
        dialog: null,
      });

      assert.deepStrictEqual(yield* Fiber.join(running), refusal("stopped"));
      yield* viewer.released;
      assert.deepStrictEqual(typed(yield* viewer.inputs), []);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("says the vault is locked, and tries nothing", () =>
    Effect.gen(function* () {
      const at = yield* scene({ url: LOGIN_URL });
      yield* (yield* Vault).lock;
      assert.deepStrictEqual(yield* fillUnheld(request(at, "password")), { _tag: "locked" });
      assert.deepStrictEqual(yield* (yield* CredentialFills).list(at.bot.id), { _tag: "locked" });
      assert.strictEqual(yield* at.browser.opens, 0);
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
          arguments: { credential: "Example", field: "password" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "TurnEnded");
      assert.strictEqual(yield* at.browser.opens, 0);
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
      const { bot, session, browser, turnId } = yield* scene({ url: LOGIN_URL });
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

      yield* call("list_credentials", {});
      for (const field of ["username", "password", "totp"] as const) {
        const running = yield* call("fill_credential", { credential: "Example", field }).pipe(
          Effect.forkChild,
        );
        yield* grantTake(yield* browser.nextViewer);
        yield* runOut(running);
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
        fillsShown.map((fill): ReadonlyArray<string | null> => [
          fill.field,
          fill.origin,
          fill.outcome._tag,
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
            credentials: [{ name: "Example", origins: ["https://example.com"] }],
            note: "Fill only into the page of one of a login's origins.",
          },
        },
        {
          _tag: "result",
          value: {
            status: "filled",
            submitted: false,
            note: "Typed into the field that had focus. The tab is yours again.",
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

const pairDevice = Effect.gen(function* () {
  const devices = yield* Devices;
  const { code } = yield* devices.startPairing;
  return (yield* devices.pair({ code, name: "Laptop" })).deviceId;
});
