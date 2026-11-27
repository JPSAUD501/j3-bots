// SPDX-License-Identifier: AGPL-3.0-or-later
import { SignInFailure, type ProviderSignInStatus } from "@j3-bots/contracts";
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";
import { type Harness, HARNESSES } from "../engine/harnesses.ts";
import { homeLayout } from "../home/entries.ts";
import * as Home from "../home/Home.ts";

// A harness's own sign-in, run for J3 Bots' home for it: in a terminal by
// `j3-bots provider login`, or with no terminal for a client, which follows
// it through `provider.signIn` (`SignIns.ts`). Both run the same command in
// the same environment and store the sign-in the same way.

/** Why a sign-in could not start, or ended without signing the harness in. */
export class SignInFailed extends Schema.TaggedError<SignInFailed>()("SignInFailed", {
  reason: SignInFailure,
  /** In English, for `provider login`. Never anything the harness printed. */
  message: Schema.String,
}) {}

const failed = (reason: SignInFailure, message: string) => new SignInFailed({ reason, message });

/**
 * Where a sign-in shows itself: in the terminal it runs from, or to a client,
 * through `report`, with no terminal.
 */
type SignInIo =
  | { readonly _tag: "terminal" }
  | {
      readonly _tag: "app";
      readonly report: (status: ProviderSignInStatus) => Effect.Effect<void>;
    };

/**
 * What a sign-in in a terminal needs past what the engine passes on: the
 * terminal, the language, and what opens a browser.
 */
const TERMINAL = new Set([
  "TERM",
  "COLORTERM",
  "LANGUAGE",
  "BROWSER",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
]);

/**
 * What a sign-in with no terminal keeps: the language, and the display, in
 * case the harness opens the browser itself instead of handing the page to
 * the program `BROWSER` names (`browser`).
 */
const NO_TERMINAL = new Set(["LANGUAGE", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]);

/**
 * How a harness's own sign-in runs for J3 Bots: its executable and arguments,
 * and the environment the engine would give it (`engineEnvironment`), plus
 * the variables a sign-in uses, with the harness's configuration folder set
 * to its J3-owned home. In a terminal those are the terminal's, the
 * language's and the browser's. With none (`browser` given), they are the
 * language's and the display's, and `BROWSER` names `browser`, which hands
 * the page to J3 Bots instead of opening it; null where no harness is known
 * to honour `BROWSER`, as on Windows. The sign-in is stored in `home`, where
 * the engine's instance reads it. Nothing else of this environment reaches
 * it: not a folder of the operator's own, such as one named in
 * `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and none of the variables that would
 * change where the sign-in goes or how, such as `ANTHROPIC_*` or `OPENAI_*`.
 */
export const signInCommand = (
  harness: Harness,
  executable: string,
  home: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly deviceAuth: boolean;
    readonly terminal: boolean;
    readonly browser: string | null;
    /** The system the harness runs on, whose variables the engine passes on. */
    readonly platform: string;
  },
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
} => {
  const facts = HARNESSES[harness];
  const passed = options.terminal ? TERMINAL : NO_TERMINAL;
  const kept = Object.entries(environment).flatMap(([name, value]) =>
    value === undefined || !passed.has(name) ? [] : [[name, value] as const],
  );
  return {
    command: executable,
    args: [
      ...facts.signIn,
      ...(options.deviceAuth && facts.deviceAuth !== undefined ? [facts.deviceAuth] : []),
    ],
    env: {
      ...EngineLive.engineEnvironment(environment, options.platform),
      ...Object.fromEntries(kept),
      ...(!options.terminal && options.browser !== null ? { BROWSER: options.browser } : {}),
      [facts.homeVariable]: home,
    },
  };
};

/** Whether `cmd.exe` reads something in `word` even in quotes: what it expands, a quote, a control character. */
const cmdReadsInQuotes = (word: string): boolean =>
  [...word].some((char) => `%!"`.includes(char) || char <= "\u001f" || char === "\u007f");

/**
 * How the system runs `executable` with `args`. On Windows a harness
 * installed with npm is a `.cmd` shim, which only `cmd.exe` runs, so its
 * command line goes to `cmd.exe` (`shell`), which Node gives it as
 * `cmd.exe /d /s /c "<line>"`. Every word of that line is quoted, so that
 * `cmd.exe` reads `& | < > ^ ( )` in a path, such as `C:\Tools & Co`, as part
 * of it rather than as a command of its own. What quotes cannot keep from
 * `cmd.exe` is refused rather than run as something else: `%` and `!`, which
 * it would expand, a `"`, which would end the quoting, and a control
 * character. **Verified** on Windows 11: a `.cmd` in a folder named
 * `R&D^(Co)` ran through `cmd.exe` with its arguments.
 */
export const invocation = (
  executable: string,
  args: ReadonlyArray<string>,
  platform: string,
): Result.Result<
  { readonly command: string; readonly args: ReadonlyArray<string>; readonly shell: boolean },
  string
> => {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) {
    return Result.succeed({ command: executable, args, shell: false });
  }
  const words: Array<string> = [];
  for (const word of [executable, ...args]) {
    if (cmdReadsInQuotes(word)) {
      return Result.fail(`${word} holds a character cmd.exe would read even in quotes`);
    }
    // In quotes, backslashes before the closing quote are doubled, so that it stays a quote.
    words.push(`"${word.replace(/(\\+)$/, "$1$1")}"`);
  }
  return Result.succeed({ command: words.join(" "), args: [], shell: true });
};

/** Whether `target` is a symbolic link. */
const isLink = Effect.fn("signIn.isLink")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * J3 Bots' home for `harness` in the data directory `dataHome`, made ready
 * for its sign-in: only in a data directory the server would accept, which
 * stays private, and never through a symbolic link, which could make the
 * sign-in act on what it points to, such as the operator's own. A sign-in in
 * a new folder (`signIn`) does not open the credential file in the home, so
 * only one signing in in place checks it. The harness's home must be private
 * too, as the data directory is: one opened to others since, by its mode or
 * its access list, gets no sign-in written in it. On Windows an inheritable
 * grant on a folder it is in reaches it, so its own list shows that too.
 */
export const prepareHome = Effect.fn("signIn.prepareHome")(function* (
  harness: Harness,
  dataHome: string,
) {
  const facts = HARNESSES[harness];
  yield* Home.checkPrivate(dataHome).pipe(
    Effect.mapError((error) => failed("home-refused", error.message)),
  );
  yield* Home.checkWritable(dataHome).pipe(
    Effect.mapError((error) => failed("home-refused", error.message)),
  );
  const path = yield* Path.Path;
  const home = homeLayout(path, dataHome).providerHome(harness);
  for (const target of [
    path.dirname(home),
    home,
    ...(facts.revokesStoredSignIn ? [] : [path.join(home, facts.credentialFile)]),
  ]) {
    if (yield* isLink(target)) {
      return yield* failed(
        "linked-home",
        `${target} is a symbolic link, so ${facts.name}'s sign-in could act on what it points to, such as your own sign-in. Remove the link, then run this again.`,
      );
    }
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .makeDirectory(home, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((error) => failed("home-refused", error.message)));
  yield* Home.checkPrivate(home).pipe(
    Effect.mapError((error) =>
      failed(
        "home-refused",
        error.reason === "open-to-others"
          ? `Other users on this machine can open ${error.home}, where ${facts.name}'s sign-in is kept. ${error.fix}`
          : error.message,
      ),
    ),
  );
  return home;
});

/** How long a sign-in may take at each step. */
interface SignInLimits {
  /** How long a sign-in with no terminal has to give a page before it counts as needing one. */
  readonly pageWait: Duration.Input;
  /** How long a sign-in waits for the operator to finish on the page. */
  readonly signInWait: Duration.Input;
  /**
   * How long a harness that was asked to stop (`SIGTERM`) has before it and
   * everything it started are killed (`SIGKILL`), as for every command the
   * engine adapter runs: a harness that ignores the request cannot hold a
   * cancel or a deadline up.
   */
  readonly stopWithin: Duration.Input;
}

const SIGN_IN_LIMITS: SignInLimits = {
  pageWait: Duration.seconds(30),
  signInWait: Duration.minutes(10),
  stopWithin: Duration.seconds(3),
};

/**
 * Adds what a harness logged of a sign-in it ran in a folder of its own to
 * `kept`, its log in the J3-owned home, private as the harness makes it. A
 * log that cannot be kept is not worth failing the sign-in for: it is
 * dropped, with a warning.
 */
const keepSignInLog = Effect.fn("provider.keepSignInLog")(function* (logged: string, kept: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFile(logged).pipe(Effect.option);
  if (Option.isNone(text) || text.value.length === 0) return;
  yield* fs.makeDirectory(path.dirname(kept), { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(fs.writeFile(kept, text.value, { flag: "a", mode: 0o600 })),
    Effect.catch((error) =>
      Effect.logWarning(`The harness's log of the sign-in was not kept in ${kept}`, error),
    ),
  );
});

/** How long a printed page waits for the same harness to hand one to `BROWSER`, which is preferred. */
const PRINTED_PAGE_GRACE = Duration.seconds(2);
/** How often the page handed to `BROWSER` is looked for. */
const PAGE_POLL = Duration.millis(250);
/** How much of what the harness printed is kept, in memory only, to tell why it ended. */
const TAIL_LENGTH = 4000;

/** What a harness says when it cannot run without a terminal. */
const NEEDS_TERMINAL = /\b(tty|terminal|raw mode|isatty|interactive)\b/i;

/**
 * The first page in `line` that `harness` signs in on (`signInPages`): an
 * `https:` URL with that origin and path and no user name or password, cut
 * at the first control character or quote, which no URL holds and a
 * terminal's colours would add. Never any other URL the harness prints, such
 * as its documentation or a diagnostic one, whatever it carries.
 */
export const pageIn = (line: string, harness: Harness): string | null => {
  const pages = HARNESSES[harness].signInPages;
  for (
    let start = line.indexOf("https://");
    start !== -1;
    start = line.indexOf("https://", start + 1)
  ) {
    let end = start;
    while (end < line.length) {
      const code = line.charCodeAt(end);
      if (code <= 0x20 || code === 0x7f || `"'<>\``.includes(line.charAt(end))) break;
      end++;
    }
    const candidate = line.slice(start, end);
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    if (
      url.username === "" &&
      url.password === "" &&
      pages.includes(`${url.origin}${url.pathname}`)
    ) {
      return candidate;
    }
  }
  return null;
};

/**
 * A program for `BROWSER` that writes the page it is given to `file`, in a
 * folder private to this user, instead of opening it.
 */
const pageReporter = (file: string) =>
  Result.map(CommandLine.quote(file), (quoted) => `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quoted}\n`);

interface Run {
  readonly harness: Harness;
  readonly executable: string;
  /** J3 Bots' home for the harness, from `prepareHome`. */
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly deviceAuth: boolean;
  readonly platform: string;
  readonly io: SignInIo;
  /** Shorter limits than a person needs, for a test. */
  readonly limits?: SignInLimits;
}

/**
 * Runs `harness`'s own sign-in for its J3-owned home, `home`. A harness
 * whose sign-in first revokes the one already stored (`revokesStoredSignIn`)
 * signs in in a new folder instead, private to this user and on the home's
 * file system, and its credential file is renamed into the home only once
 * the sign-in succeeded: one stored there, such as a copy of the operator's
 * own, is neither revoked nor changed by a sign-in that fails or is
 * cancelled. The folder is removed however the sign-in ends, short of this
 * process being killed outright, and what the harness logged of its sign-in
 * there (`signInLog`) is first added to the log in the home.
 *
 * In a terminal, the harness has it. With none (`io` is `app`), what the
 * harness prints is read for the page it waits on, kept in memory only, and
 * never logged or passed on: only the page is, through `report`. The page
 * `BROWSER` is handed is preferred to a printed one, since the harness opens
 * nothing itself then. A sign-in that gives no page within `pageWait`, or
 * ends before one saying it needs a terminal, needs one; one not finished
 * within `signInWait` is stopped. Interrupting it stops the harness, and
 * however it ends, the harness and everything it started are stopped within
 * `stopWithin` (`SignInLimits`).
 */
export const signIn = Effect.fn("provider.signIn")(function* (run: Run) {
  const { harness, home } = run;
  const facts = HARNESSES[harness];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unexpected = (error: { readonly message: string }) => failed("unexpected", error.message);
  const folder = facts.revokesStoredSignIn
    ? yield* fs
        .makeTempDirectoryScoped({ directory: home, prefix: ".sign-in-" })
        .pipe(Effect.mapError(unexpected))
    : home;
  const { signInLog } = facts;
  if (folder !== home && signInLog !== undefined) {
    // Runs before the folder is removed: finalizers run last-added first.
    yield* Effect.addFinalizer(() =>
      keepSignInLog(path.join(folder, signInLog), path.join(home, signInLog)),
    );
  }
  const terminal = run.io._tag === "terminal";
  const limits = run.limits ?? SIGN_IN_LIMITS;
  // Where `BROWSER` hands the page, with no terminal, where a harness is known
  // to honour it: in J3 Bots' private folder of provider homes, which a folder
  // the system mounts `noexec`, such as `/tmp` often is, would not run.
  const pageFile =
    terminal || run.platform === "win32"
      ? null
      : path.join(
          yield* fs
            .makeTempDirectoryScoped({ directory: path.dirname(home), prefix: ".sign-in-page-" })
            .pipe(Effect.mapError(unexpected)),
          "page",
        );
  let browser: string | null = null;
  if (pageFile !== null) {
    browser = path.join(path.dirname(pageFile), "open-page");
    const script = pageReporter(pageFile);
    if (Result.isFailure(script))
      return yield* failed("unexpected", "No page reporter could be written");
    yield* fs
      .writeFileString(browser, script.success, { mode: 0o700 })
      .pipe(Effect.mapError(unexpected));
  }
  const command = signInCommand(harness, run.executable, folder, run.environment, {
    deviceAuth: run.deviceAuth,
    terminal,
    browser,
    platform: run.platform,
  });
  const how = invocation(command.command, command.args, run.platform);
  if (Result.isFailure(how)) return yield* failed("unexpected", how.failure);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const options = {
    env: command.env,
    extendEnv: false,
    shell: how.success.shell,
    windowsHide: !terminal,
    killSignal: "SIGTERM",
    forceKillAfter: limits.stopWithin,
  } as const;
  const unchanged = folder === home ? "" : ` The sign-in in ${home} is as it was.`;

  let exitCode: number;
  if (run.io._tag === "terminal") {
    exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(how.success.command, how.success.args, {
          ...options,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.mapError(unexpected));
  } else {
    const { report } = run.io;
    yield* report({ _tag: "starting" });
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(how.success.command, how.success.args, {
          ...options,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(Effect.mapError(unexpected));
    const page = yield* Deferred.make<string>();
    const tail = yield* Ref.make("");
    const printed = yield* Ref.make(false);
    // What the harness prints: kept short, in memory, for why it ended, and read for a page.
    const reading = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          yield* Ref.update(tail, (text) => `${text}${line}\n`.slice(-TAIL_LENGTH));
          const url = pageIn(line, harness);
          if (url === null || (yield* Ref.getAndSet(printed, true))) return;
          // The harness may also hand it to `BROWSER`, which then wins.
          yield* Effect.sleep(PRINTED_PAGE_GRACE).pipe(
            Effect.andThen(Deferred.succeed(page, url)),
            Effect.forkScoped,
          );
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    if (pageFile !== null) {
      const file = pageFile;
      yield* Effect.gen(function* () {
        while (true) {
          const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
          const url = text
            .split("\n")
            .map((line) => pageIn(line, harness))
            .find((found) => found !== null);
          if (url !== undefined && url !== null) {
            return yield* Deferred.succeed(page, url);
          }
          yield* Effect.sleep(PAGE_POLL);
        }
      }).pipe(Effect.forkScoped);
    }
    yield* Deferred.await(page).pipe(
      // The client opens it, whether or not the harness also did: whether it
      // did, nothing here can tell (decision 0085).
      Effect.flatMap((url) => report({ _tag: "waiting-for-browser", url, opened: false })),
      Effect.forkScoped,
    );
    const noPage = Deferred.await(page).pipe(
      Effect.timeoutOption(limits.pageWait),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.never
          : Effect.fail(
              failed(
                "needs-terminal",
                `${facts.name} gave no page to sign in on without a terminal.${unchanged}`,
              ),
            ),
      ),
    );
    const ended = yield* handle.exitCode.pipe(
      Effect.mapError(unexpected),
      Effect.raceFirst(noPage),
      Effect.timeoutOption(limits.signInWait),
    );
    if (Option.isNone(ended)) {
      return yield* failed(
        "timed-out",
        `Nobody finished ${facts.name}'s sign-in in time, so it was stopped.${unchanged}`,
      );
    }
    exitCode = ended.value;
    // What it printed last, unless something it started still holds its output open.
    yield* Fiber.join(reading).pipe(Effect.timeoutOption(Duration.seconds(1)));
    if (exitCode !== 0 && !(yield* Deferred.isDone(page))) {
      const said = yield* Ref.get(tail);
      return yield* failed(
        NEEDS_TERMINAL.test(said) ? "needs-terminal" : "ended",
        `${facts.name}'s sign-in ended with status ${exitCode} before it gave a page to sign in on.${unchanged}`,
      );
    }
  }
  if (exitCode !== 0) {
    return yield* failed(
      "ended",
      `${facts.name}'s sign-in ended with status ${exitCode}.${unchanged}`,
    );
  }
  if (folder === home) return;
  const signedIn = path.join(folder, facts.credentialFile);
  if (!(yield* fs.exists(signedIn).pipe(Effect.mapError(unexpected)))) {
    return yield* failed(
      "no-credential",
      `${facts.name}'s sign-in finished without writing ${facts.credentialFile}, the file the engine's ${facts.name} reads its sign-in from.${unchanged}`,
    );
  }
  // A rename replaces a link at the destination, never what it points to.
  yield* fs
    .rename(signedIn, path.join(home, facts.credentialFile))
    .pipe(Effect.mapError(unexpected));
}, Effect.scoped);
