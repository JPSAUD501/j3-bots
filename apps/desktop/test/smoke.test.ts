// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron's package answers its executable's path only to require(), and the redirecting address is a plain node:http server.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import { BotId, CommandId, ServerOrigin } from "@j3-bots/contracts";
import { AppLinkUrl, BRIDGE_KEY, OpenResult, TokenProtection } from "@j3-bots/desktop-bridge";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

// The development build, launched as the operator launches it, against the
// server's testing layer (its real routes and socket over the in-memory
// engine) on loopback: refuse an address that redirects, name the server,
// pair, open a bot from the roster, send it a message with a file, find the
// token nowhere on disk in the clear, launch again still paired, keep a
// credential the system will not open, read a damaged one as not paired, and
// change server from Settings; and follow links to the app, given at launch
// and handed over by a second launch. Needs the web client built and a display
// (`xvfb-run`).

/** How long one step may take before the smoke fails, a cold Electron start included. */
const STEP = 30_000;

const electronPath = (): string => {
  const path: unknown = NodeModule.createRequire(import.meta.url)("electron");
  if (typeof path !== "string") throw new Error("The electron package gave no executable path.");
  return path;
};

// Linux CI runners do not allow the Chromium sandbox's user namespaces (as T3 Code's smoke).
// The page's language follows the system's; the steps below read English.
const ARGS = [`${import.meta.dirname}/..`, "--no-sandbox", "--lang=en-US"];

/**
 * A fresh profile: Electron keeps userData under XDG_CONFIG_HOME on Linux. The
 * app's handler of its links, a desktop entry and the default it names, is
 * kept under the same folder, away from the session running the smoke.
 */
const environment = (profile: string) => ({
  ...process.env,
  XDG_CONFIG_HOME: profile,
  XDG_DATA_HOME: `${profile}/data`,
  LANGUAGE: "en_US",
  LC_ALL: "en_US.UTF-8",
});

/** The app on `profile`, started with `links` as a link to the app is handed to it. */
const launch = (profile: string, links: ReadonlyArray<string> = []) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      _electron.launch({
        executablePath: electronPath(),
        args: [...ARGS, ...links],
        env: environment(profile),
        timeout: STEP,
      }),
    ),
    // A no-op once the test has closed it.
    (app: ElectronApplication) => Effect.promise(() => app.close()),
  );

/**
 * A second launch on `profile` with `link`, as the system starts the app for a
 * link while it runs: it hands the link to the running app and exits.
 */
const launchAgainWith = (profile: string, link: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(electronPath(), [...ARGS, link], {
        env: environment(profile),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* handle.exitCode);
  }).pipe(Effect.scoped, Effect.timeout(STEP));

const linkTo = Schema.encodeSync(AppLinkUrl("j3bots-dev"));

/** The page's stored credential record, as JSON. */
const storedCredential = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const opening = indexedDB.open("j3-bots");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const read = opening.result
            .transaction("credentials")
            .objectStore("credentials")
            .get("device");
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            opening.result.close();
            resolve(read.result);
          };
        };
      }),
  );

/** Replaces the page's stored credential record with `value`. */
const storeCredential = (page: Page, value: string) =>
  page.evaluate(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("j3-bots");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const transaction = opening.result.transaction("credentials", "readwrite");
          transaction.objectStore("credentials").put(value, "device");
          transaction.oncomplete = () => {
            opening.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    value,
  );

const SealedRecord = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    server: Schema.String,
    sealed: Schema.String,
    protection: TokenProtection,
  }),
);

/** Whether any file under `directory` holds `secret`, as UTF-8 or UTF-16. Never prints it. */
const holdsAnywhere = (directory: string, secret: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const needles = [Buffer.from(secret, "utf8"), Buffer.from(secret, "utf16le")];
    for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
      const file = path.join(directory, entry);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const bytes = Buffer.from(
        yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => new Uint8Array())),
      );
      if (needles.some((needle) => bytes.includes(needle))) return true;
    }
    return false;
  });

/** A loopback server that redirects every request to `target`; answers its host. Closed with the scope. */
const redirectingTo = (target: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) =>
        response.writeHead(302, { location: `${target}${request.url ?? "/"}` }).end(),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.die("not an IP listener")
        : Effect.succeed(`127.0.0.1:${address.port}`);
    }),
  );

it.layer(Layer.mergeAll(Server.layer(Layer.empty), NodeServices.layer), {
  excludeTestServices: true,
})("desktop app", (it) => {
  it.effect(
    "names a server, pairs, sends a file, stays paired, and changes server",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("smoke-bot"),
          draft: { name: "Smoke Bot", job: "" },
        });
        const devices = yield* Server.Devices;
        const entries = yield* Server.Entries;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-smoke-" });
        const redirecting = yield* redirectingTo(origin.origin);

        /** Runs `steps` on `page`; on failure, keeps what the window showed for the CI run's artifacts. */
        const onPage = <A>(page: Page, steps: () => Promise<A>) =>
          Effect.promise(steps).pipe(
            Effect.onError(() =>
              Effect.promise(() =>
                page
                  .screenshot({ path: `${import.meta.dirname}/../smoke-failure.png` })
                  .catch(() => undefined),
              ),
            ),
          );
        const pair = (page: Page) =>
          devices.startPairing.pipe(
            Effect.flatMap(({ code }) =>
              onPage(page, async () => {
                await page.getByLabel("Pairing code").fill(code, { timeout: STEP });
                await page.getByRole("button", { name: "Pair", exact: true }).click();
                await page.getByText(bot.profile.name).first().waitFor({ timeout: STEP });
              }),
            ),
          );

        const app = yield* launch(profile);
        const page = yield* Effect.promise(() => app.firstWindow({ timeout: STEP }));
        yield* onPage(page, async () => {
          // An address that redirects to the server is not taken for it.
          await page.getByLabel("Server address").fill(redirecting, { timeout: STEP });
          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByText("isn’t J3 Bots").waitFor({ state: "visible", timeout: STEP });
          await page.getByLabel("Server address").fill(origin.host);
          await page.getByRole("button", { name: "Continue" }).click();
        });
        yield* pair(page);
        // A message with a file, uploaded from the page as in a browser.
        yield* onPage(page, async () => {
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page.locator('input[type="file"]').setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("A file from the desktop\n".repeat(4096)),
          });
          await page.getByRole("button", { name: "Remove notes.txt" }).waitFor({ timeout: STEP });
          await page.getByText(/^Uploading/).waitFor({ state: "detached", timeout: STEP });
          await page
            .getByRole("textbox", { name: `Message ${bot.profile.name}` })
            .fill("Hello from the desktop", { timeout: STEP });
          await page.getByRole("button", { name: "Send message" }).click();
          await page
            .getByText("Hello from the desktop")
            .first()
            .waitFor({ state: "visible", timeout: STEP });
        });
        // The page shows the message as it sends it; the server has it once it arrives.
        const arrived = yield* entries.latest({ _tag: "conversation", botId: bot.id }, 10).pipe(
          Effect.map((latest) =>
            latest.some(
              (entry) =>
                entry._tag === "message" &&
                entry.text === "Hello from the desktop" &&
                entry.attachments.some((file) => file.name === "notes.txt"),
            ),
          ),
          Effect.repeat({ until: (found) => found, schedule: Schedule.spaced("100 millis") }),
          Effect.timeoutOption(STEP),
        );
        assert.isTrue(Option.isSome(arrived));
        assert.strictEqual(new URL(page.url()).protocol, "j3bots-dev:");

        // The credential is stored sealed; the token it holds is nowhere on disk in the clear.
        const record = yield* Schema.decodeUnknownEffect(SealedRecord)(
          yield* Effect.promise(() => storedCredential(page)),
        );
        assert.strictEqual(record.server, origin.origin);
        const token = yield* Effect.promise(() =>
          page.evaluate(
            ({ key, sealed }) => {
              const bridge: unknown = Reflect.get(window, key);
              const open: unknown =
                typeof bridge === "object" && bridge !== null
                  ? Reflect.get(bridge, "openToken")
                  : null;
              return typeof open === "function" ? Promise.resolve(open(sealed)) : null;
            },
            { key: BRIDGE_KEY, sealed: record.sealed },
          ),
        );
        const opened = Schema.decodeUnknownOption(OpenResult)(token).pipe(
          Option.flatMap((answer) =>
            answer._tag === "opened" ? Option.some(answer.token) : Option.none(),
          ),
        );
        assert.isTrue(Option.isSome(opened), "the stored token opens");
        yield* Effect.promise(() => app.close());
        // The scan reads what IndexedDB wrote: the sealed form is there.
        assert.isTrue(yield* holdsAnywhere(profile, record.sealed), "the sealed token is on disk");
        if (Option.isSome(opened)) {
          assert.isFalse(
            yield* holdsAnywhere(profile, opened.value),
            "a profile file holds the device token in the clear",
          );
        }

        // Launched again, the app is still paired.
        const again = yield* launch(profile);
        const second = yield* Effect.promise(() => again.firstWindow({ timeout: STEP }));
        yield* onPage(second, () =>
          second.getByText(bot.profile.name).first().waitFor({ state: "visible", timeout: STEP }),
        );
        // A credential the system refuses to open (here, not sealed by it) may open later, as
        // once a keyring is unlocked: the pairing stays, and the app says it cannot read it.
        yield* Effect.promise(() =>
          storeCredential(
            second,
            JSON.stringify({
              ...record,
              sealed: Buffer.from("not this profile's key").toString("base64"),
            }),
          ),
        );
        yield* onPage(second, async () => {
          await second.reload();
          await second
            .getByText("This device’s sign-in can’t be read")
            .waitFor({ state: "visible", timeout: STEP });
        });
        // One that opens to something the app did not seal reads as not paired: the pairing
        // screen, then pairing again. A byte changed in the first block of the ciphertext
        // (after Chromium's three-byte version) garbles what it decrypts to and keeps its padding.
        const damaged = Buffer.from(record.sealed, "base64");
        damaged.writeUInt8(damaged.readUInt8(3) ^ 0xff, 3);
        yield* Effect.promise(() =>
          storeCredential(
            second,
            JSON.stringify({ ...record, sealed: damaged.toString("base64") }),
          ),
        );
        yield* onPage(second, async () => {
          await second.reload();
          await second.getByLabel("Pairing code").waitFor({ state: "visible", timeout: STEP });
        });
        yield* pair(second);

        // Settings says the sign-in is stored without encryption exactly when the record does.
        const paired = yield* Schema.decodeUnknownEffect(SealedRecord)(
          yield* Effect.promise(() => storedCredential(second)),
        );
        // Changing server from Settings forgets this device's pairing here.
        const stored = yield* onPage(second, async () => {
          await second.getByRole("button", { name: "Settings" }).click();
          await second
            .getByText("this device’s sign-in is stored without encryption", { exact: false })
            .waitFor({
              state: paired.protection === "unencrypted" ? "visible" : "hidden",
              timeout: STEP,
            });
          await second.getByRole("button", { name: "Change server" }).click();
          await second
            .getByRole("alertdialog")
            .getByRole("button", { name: "Change server" })
            .click();
          await second.getByLabel("Server address").waitFor({ state: "visible", timeout: STEP });
          return second.evaluate(() => indexedDB.databases());
        });
        assert.deepStrictEqual(stored, []);
        // The window's place is saved as it closes.
        yield* Effect.promise(() => again.close());
        const saved = yield* fs.readFileString(
          path.join(profile, "J3 Bots Development", "desktop.json"),
        );
        assert.include(saved, `"server":null`);
        assert.include(saved, `"window":{`);
      }),
    180_000,
  );

  it.effect(
    "follows a pairing link to the screens it fills in, and a second launch's link to a bot",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("link-bot"),
          draft: { name: "Link Bot", job: "" },
        });
        const { code } = yield* (yield* Server.Devices).startPairing;
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-links-" });
        const server = yield* Schema.decodeEffect(ServerOrigin)(origin.origin);

        // Launched for a pairing link before any server is named: the address
        // screen shows the link's server, and continuing to it brings the
        // pairing screen with the link's code. Nothing pairs until Pair: the
        // code, which works once, still pairs then.
        const app = yield* launch(profile, [linkTo({ _tag: "pair", server, code })]);
        const page = yield* Effect.promise(() => app.firstWindow({ timeout: STEP }));
        yield* Effect.promise(async () => {
          const address = page.getByLabel("Server address");
          await page.getByText("This pairing link is for").waitFor({ timeout: STEP });
          assert.strictEqual(await address.inputValue(), origin.origin);
          await page.getByRole("button", { name: "Continue" }).click();
          const field = page.getByLabel("Pairing code");
          await field.waitFor({ timeout: STEP });
          assert.strictEqual(await field.inputValue(), code);
          await page.getByRole("button", { name: "Pair", exact: true }).click();
          await page.getByText(bot.profile.name).first().waitFor({ timeout: STEP });
        });

        // A second launch with a link to the bot hands it to the running app,
        // which opens the bot's conversation; one to a bot this server does
        // not have leaves the screen as it is, and says so.
        assert.strictEqual(
          yield* launchAgainWith(
            profile,
            linkTo({ _tag: "open", target: { _tag: "conversation", botId: bot.id } }),
          ),
          0,
        );
        yield* Effect.promise(async () => {
          await page.waitForURL(`j3bots-dev://app/bots/${bot.id}`, { timeout: STEP });
          await page
            .getByRole("textbox", { name: `Message ${bot.profile.name}` })
            .waitFor({ timeout: STEP });
        });
        assert.strictEqual(
          yield* launchAgainWith(
            profile,
            linkTo({
              _tag: "open",
              target: { _tag: "conversation", botId: BotId.make("bot_gone") },
            }),
          ),
          0,
        );
        yield* Effect.promise(async () => {
          await page
            .getByText("That link is for a bot this server doesn’t have.")
            .waitFor({ timeout: STEP });
          assert.strictEqual(page.url(), `j3bots-dev://app/bots/${bot.id}`);
        });
      }),
    120_000,
  );
});
