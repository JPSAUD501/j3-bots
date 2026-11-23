// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the redirecting address is a plain node:http server.
import * as NodeHttp from "node:http";
import { BotId, CommandId, ServerOrigin } from "@j3-bots/contracts";
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
import type { Page } from "playwright-core";
import {
  ARGS,
  electronPath,
  environment,
  launch,
  linkTo,
  openToken,
  SealedRecord,
  STEP,
  storedCredential,
} from "./electron.ts";

// The development build, launched as the operator launches it, against the
// server's testing layer (its real routes and socket over the in-memory
// engine) on loopback: refuse an address that redirects, name the server,
// pair, open a bot from the roster, send it a message with a file, show the
// window from the application menu with the cursor in the composer, find the
// token nowhere on disk in the clear, launch again still paired, keep a
// credential the system will not open, read a damaged one as not paired, and
// change server from Settings; and follow links to the app, given at launch
// and handed over by a second launch. Needs the web client built and a display
// (`xvfb-run`).

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

it.layer(Layer.mergeAll(Server.layer(Server.connectorsUnserved), NodeServices.layer), {
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
          await page
            .getByRole("main")
            .locator('input[type="file"]')
            .setInputFiles({
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

        // The application menu's Show, which the global shortcut also runs:
        // the window comes forward with the cursor in the open conversation's composer.
        yield* onPage(page, async () => {
          await page.getByRole("button", { name: "Settings" }).focus();
          const composer = await page
            .getByRole("textbox", { name: `Message ${bot.profile.name}` })
            .elementHandle({ timeout: STEP });
          await app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()?.getMenuItemById("show")?.click();
          });
          await page.waitForFunction((element) => element === document.activeElement, composer, {
            timeout: STEP,
          });
        });

        // The credential is stored sealed; the token it holds is nowhere on disk in the clear.
        const record = yield* Schema.decodeUnknownEffect(SealedRecord)(
          yield* Effect.promise(() => storedCredential(page)),
        );
        assert.strictEqual(record.server, origin.origin);
        const opened = yield* openToken(page, record.sealed);
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
