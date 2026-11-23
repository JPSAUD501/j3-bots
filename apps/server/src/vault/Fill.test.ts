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
import { EngineTabId, type SessionId } from "@j3-bots/engine-t3";
import { type FakeViewer, TestBrowserControl } from "@j3-bots/engine-t3/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
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
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { WorkSteps } from "../turns/WorkSteps.ts";
import { CredentialFills, type FillRequest, layerWith } from "./Fill.ts";
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

/** The tests' waits: short, on the test clock. */
const fills = layerWith({
  take: Duration.seconds(5),
  navigation: Duration.seconds(6),
  poll: Duration.millis(100),
});

const domain = fills.pipe(Layer.provideMerge(TestDomain.layer));

/**
 * A bot with its vault access on, the login `Example` saved for `origins` and
 * allowed to it, and one tab open at `url`.
 */
const scene = (input: {
  readonly url: string;
  readonly origins?: ReadonlyArray<string>;
  readonly vaultAccess?: boolean;
  readonly allowed?: boolean;
}) =>
  Effect.gen(function* () {
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    if (input.vaultAccess ?? true) {
      yield* (yield* Bots).update({
        commandId: command(),
        botId: bot.id,
        changes: { vault: true },
      });
    }
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
    return { bot, session, browser, tab, caller };
  });

let requests = 0;

const request = (
  caller: FillRequest["caller"],
  session: SessionId,
  field: FillRequest["field"],
  submit = false,
): FillRequest => ({
  requestId: `fill-${++requests}`,
  caller,
  engineSessionId: session,
  credential: "Example",
  field,
  submit,
});

/** Answers the server's take of the tab as the engine does once it holds it. */
const grantTake = (viewer: FakeViewer) =>
  Effect.gen(function* () {
    const first = yield* viewer.nextInput;
    assert.deepStrictEqual(first, { type: "take" });
    yield* viewer.emit({ _tag: "control", controller: "this-viewer", generation: 1, dialog: null });
  });

/** Starts a fill, holding the tab for it as the engine would, and answers it with its viewer. */
const fillHeld = (fill: FillRequest) =>
  Effect.gen(function* () {
    const browser = yield* TestBrowserControl;
    const running = yield* (yield* CredentialFills).fill(fill).pipe(Effect.forkChild);
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

const keys = (inputs: ReadonlyArray<BrowserInput>) =>
  inputs.flatMap((input) => (input.type === "key" ? [`${input.key} ${input.action}`] : []));

const loaded = (url: string) => ({ _tag: "loaded", url }) as const;

describe("filling a saved login", () => {
  it.effect("types the password while it holds the tab, presses Enter, then gives it back", () =>
    Effect.gen(function* () {
      const { session, browser, caller } = yield* scene({ url: LOGIN_URL });
      // Checked after the take and again before typing; then the page moves on.
      yield* browser.scriptReads([
        loaded(LOGIN_URL),
        loaded(LOGIN_URL),
        loaded("https://example.com/home"),
      ]);
      const { running, viewer } = yield* fillHeld(request(caller, session, "password"));

      const outcome = yield* Fiber.join(running);
      assert.deepStrictEqual(outcome, { _tag: "filled", submitted: true });
      yield* viewer.released;
      const inputs = yield* viewer.inputs;
      assert.deepStrictEqual(typed(inputs), [PASSWORD]);
      // Enter within the hold, the release last.
      assert.deepStrictEqual(keys(inputs), ["Enter down", "Enter up"]);
      assert.deepStrictEqual(inputs.at(-1), { type: "release" });
    }).pipe(Effect.provide(domain)),
  );

  it.effect("submits a password filled without `submit`, and clears it on a page that stays", () =>
    Effect.gen(function* () {
      const { session, caller } = yield* scene({ url: LOGIN_URL });
      const { running, viewer } = yield* fillHeld(request(caller, session, "password", false));

      // The page never moves on: the server waits it out, then clears the field.
      assert.deepStrictEqual(yield* runOut(running), { _tag: "filled", submitted: true });
      const pressed = keys(yield* viewer.inputs);
      assert.deepStrictEqual(pressed.slice(0, 2), ["Enter down", "Enter up"]);
      assert.deepStrictEqual(
        pressed.slice(2),
        Array.from(PASSWORD).flatMap(() => ["Backspace down", "Backspace up"]),
      );
      assert.deepStrictEqual((yield* viewer.inputs).at(-1), { type: "release" });
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types a user name alone, and presses Enter only when asked", () =>
    Effect.gen(function* () {
      const { session, caller } = yield* scene({ url: LOGIN_URL });
      const first = yield* fillHeld(request(caller, session, "username"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), {
        _tag: "filled",
        submitted: false,
      });
      const inputs = yield* first.viewer.inputs;
      assert.deepStrictEqual(typed(inputs), [USERNAME]);
      assert.deepStrictEqual(keys(inputs), []);

      const second = yield* fillHeld(request(caller, session, "username", true));
      assert.deepStrictEqual(yield* Fiber.join(second.running), {
        _tag: "filled",
        submitted: true,
      });
      assert.deepStrictEqual(keys(yield* second.viewer.inputs), ["Enter down", "Enter up"]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("types the one-time code of the moment, as RFC 6238 gives it", () =>
    Effect.gen(function* () {
      const { session, caller } = yield* scene({ url: LOGIN_URL });
      // The seed's codes at T = 0 s (counter 0, RFC 4226 Appendix D, to eight
      // digits) and T = 59 s (RFC 6238 Appendix B); `totp.test.ts` has the rest.
      for (const [seconds, code] of [
        [0, "84755224"],
        [59, "94287082"],
      ] as const) {
        yield* TestClock.setTime(seconds * 1000);
        const { running, viewer } = yield* fillHeld(request(caller, session, "totp"));
        assert.deepStrictEqual(yield* Fiber.join(running), { _tag: "filled", submitted: false });
        assert.deepStrictEqual(typed(yield* viewer.inputs), [code]);
      }
    }).pipe(Effect.provide(domain)),
  );

  it.effect("fills over plain http only on this computer", () =>
    Effect.gen(function* () {
      const { session, caller } = yield* scene({
        url: "http://127.0.0.1:8080/login",
        origins: ["http://127.0.0.1:8080"],
      });
      const { running, viewer } = yield* fillHeld(request(caller, session, "username"));
      assert.deepStrictEqual(yield* Fiber.join(running), { _tag: "filled", submitted: false });
      assert.deepStrictEqual(typed(yield* viewer.inputs), [USERNAME]);
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
  ];

  for (const [what, url, expected] of refusedAt) {
    it.effect(`refuses ${what}, typing nothing`, () =>
      Effect.gen(function* () {
        const { session, caller } = yield* scene({ url });
        const { running, viewer } = yield* fillHeld(request(caller, session, "password"));
        assert.deepStrictEqual(yield* Fiber.join(running), expected);
        yield* viewer.released;
        assert.deepStrictEqual(typed(yield* viewer.inputs), []);
      }).pipe(Effect.provide(domain)),
    );
  }

  it.effect("refuses a page still loading, and one that moves while the tab is held", () =>
    Effect.gen(function* () {
      const loading = yield* scene({ url: LOGIN_URL });
      yield* loading.browser.scriptReads([{ _tag: "loading", url: LOGIN_URL }]);
      const first = yield* fillHeld(request(loading.caller, loading.session, "password"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), refusal("loading"));

      // The same origin, another page: still a move.
      yield* loading.browser.scriptReads([loaded(LOGIN_URL), loaded("https://example.com/other")]);
      yield* loading.browser.setTabs([]);
      const tab = EngineTabId.make("tab-2");
      yield* loading.browser.setTabs([
        {
          id: tab,
          sessionId: loading.session,
          url: LOGIN_URL,
          title: "Sign in",
          loading: false,
          activeAt: 2,
        },
      ]);
      const tabs = yield* BrowserTabs;
      yield* eventually(
        tabs
          .frontOf(loading.session)
          .pipe(Effect.map(Option.filter((front) => front.tab.id === tab))),
      );
      const second = yield* fillHeld(request(loading.caller, loading.session, "password"));
      assert.deepStrictEqual(yield* Fiber.join(second.running), refusal("navigated"));
      assert.deepStrictEqual(typed(yield* second.viewer.inputs), []);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("takes no other fill on that tab in the same turn, whatever it asks", () =>
    Effect.gen(function* () {
      const { session, browser, caller } = yield* scene({ url: "https://evil.example.net/" });
      const first = yield* fillHeld(request(caller, session, "password"));
      assert.deepStrictEqual(yield* Fiber.join(first.running), refusal("origin"));
      const opened = yield* browser.opens;

      const again = yield* (yield* CredentialFills).fill(request(caller, session, "username"));
      assert.deepStrictEqual(again, refusal("refused-before"));
      assert.strictEqual(yield* browser.opens, opened);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("refuses a tab a person holds, from a device or as the engine says", () =>
    Effect.gen(function* () {
      const { session, browser, tab, caller } = yield* scene({ url: LOGIN_URL });
      const fills = yield* CredentialFills;
      const tabs = yield* BrowserTabs;

      // The engine answers the take: another viewer has it.
      const running = yield* fills
        .fill(request(caller, session, "password"))
        .pipe(Effect.forkChild);
      const viewer = yield* browser.nextViewer;
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
      const opened = yield* browser.opens;
      yield* tabs.holding(tab, yield* pairDevice, true);
      assert.deepStrictEqual(
        yield* fills.fill(request(caller, session, "password")),
        refusal("held"),
      );
      assert.strictEqual(yield* browser.opens, opened);
    }).pipe(Effect.provide(domain)),
  );
});

describe("a fill refused before the page", () => {
  it.effect("refuses a bot without vault access, and a login not allowed to it", () =>
    Effect.gen(function* () {
      const off = yield* scene({ url: LOGIN_URL, vaultAccess: false });
      const fills = yield* CredentialFills;
      assert.deepStrictEqual(
        yield* fills.fill(request(off.caller, off.session, "password")),
        refusal("no-access"),
      );
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
      assert.deepStrictEqual(
        yield* fills.fill(request(off.caller, off.session, "password")),
        refusal("unknown-login"),
      );
      assert.deepStrictEqual(yield* fills.list(off.bot.id), { _tag: "listed", credentials: [] });
      assert.strictEqual(yield* off.browser.opens, 0);
    }).pipe(Effect.provide(domain)),
  );

  it.effect("says the vault is locked, and tries nothing", () =>
    Effect.gen(function* () {
      const { bot, session, browser, caller } = yield* scene({ url: LOGIN_URL });
      yield* (yield* Vault).lock;
      const fills = yield* CredentialFills;
      assert.deepStrictEqual(yield* fills.fill(request(caller, session, "password")), {
        _tag: "locked",
      });
      assert.deepStrictEqual(yield* fills.list(bot.id), { _tag: "locked" });
      assert.strictEqual(yield* browser.opens, 0);
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
      const { bot, session, browser } = yield* scene({ url: LOGIN_URL });
      const tools = yield* BotTools;
      yield* sendToBot(bot.id, "Sign in to Example.");
      yield* nextTurn(bot.id);
      const answers: Array<unknown> = [];
      const call = (tool: string, input: object) =>
        tools
          .call({
            requestId: `call-${++requests}`,
            sessionId: session,
            tool,
            arguments: { ...input },
          })
          .pipe(Effect.tap((answer) => Effect.sync(() => answers.push(answer))));

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
