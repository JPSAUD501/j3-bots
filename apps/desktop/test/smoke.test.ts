// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Electron's package answers its executable's path only to require(), and the redirecting address is a plain node:http server.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import { CommandId } from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { _electron, type ElectronApplication } from "playwright-core";

// The development build, launched as the operator launches it, against the
// server's testing layer (its real routes and socket over the in-memory
// engine) on loopback: refuse an address that redirects, name the server,
// pair, open a bot from the roster, send it a message, and change server from
// Settings. Needs the web client built and a display (`xvfb-run`).

/** How long one step may take before the smoke fails, a cold Electron start included. */
const STEP = 30_000;

const electronPath = (): string => {
  const path: unknown = NodeModule.createRequire(import.meta.url)("electron");
  if (typeof path !== "string") throw new Error("The electron package gave no executable path.");
  return path;
};

const launch = (profile: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      _electron.launch({
        executablePath: electronPath(),
        // Linux CI runners do not allow the Chromium sandbox's user namespaces (as T3 Code's smoke).
        // The page's language follows the system's; the steps below read English.
        args: [`${import.meta.dirname}/..`, "--no-sandbox", "--lang=en-US"],
        // A fresh profile: Electron keeps userData under XDG_CONFIG_HOME on Linux.
        env: { ...process.env, XDG_CONFIG_HOME: profile, LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" },
        timeout: STEP,
      }),
    ),
    // A no-op once the test has closed it.
    (app: ElectronApplication) => Effect.promise(() => app.close()),
  );

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
    "names a server, pairs with it, sends a bot a message, and changes server",
    () =>
      Effect.gen(function* () {
        const origin = yield* Server.origin;
        const bot = yield* (yield* Server.Bots).create({
          commandId: CommandId.make("smoke-bot"),
          draft: { name: "Smoke Bot", job: "" },
        });
        const { code } = yield* (yield* Server.Devices).startPairing;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "j3-desktop-smoke-" });
        const redirecting = yield* redirectingTo(origin.origin);

        const app = yield* launch(profile);
        const page = yield* Effect.promise(() => app.firstWindow({ timeout: STEP }));
        yield* Effect.promise(async () => {
          // An address that redirects to the server is not taken for it.
          await page.getByLabel("Server address").fill(redirecting, { timeout: STEP });
          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByText("isn’t J3 Bots").waitFor({ state: "visible", timeout: STEP });
          await page.getByLabel("Server address").fill(origin.host);
          await page.getByRole("button", { name: "Continue" }).click();
          await page.getByLabel("Pairing code").fill(code, { timeout: STEP });
          await page.getByRole("button", { name: "Pair", exact: true }).click();
          await page.getByText(bot.profile.name).first().click({ timeout: STEP });
          await page
            .getByRole("textbox", { name: `Message ${bot.profile.name}` })
            .fill("Hello from the desktop", { timeout: STEP });
          await page.getByRole("button", { name: "Send message" }).click();
          await page
            .getByText("Hello from the desktop")
            .first()
            .waitFor({ state: "visible", timeout: STEP });
        }).pipe(
          // On failure, what the window showed, for the CI run's artifacts.
          Effect.onError(() =>
            Effect.promise(() =>
              page
                .screenshot({ path: `${import.meta.dirname}/../smoke-failure.png` })
                .catch(() => undefined),
            ),
          ),
        );
        // The page shows the message as it sends it; the server has it once it arrives.
        const arrived = yield* (yield* Server.Entries)
          .latest({ _tag: "conversation", botId: bot.id }, 10)
          .pipe(
            Effect.map((latest) =>
              latest.some(
                (entry) => entry._tag === "message" && entry.text === "Hello from the desktop",
              ),
            ),
            Effect.repeat({ until: (found) => found, schedule: Schedule.spaced("100 millis") }),
            Effect.timeoutOption(STEP),
          );
        assert.isTrue(Option.isSome(arrived));
        assert.strictEqual(new URL(page.url()).protocol, "j3bots-dev:");
        // Changing server from Settings forgets this device's pairing here.
        const stored = yield* Effect.promise(async () => {
          await page.getByRole("button", { name: "Settings" }).click();
          await page.getByRole("button", { name: "Change server" }).click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Change server" })
            .click();
          await page.getByLabel("Server address").waitFor({ state: "visible", timeout: STEP });
          return page.evaluate(() => indexedDB.databases());
        });
        assert.deepStrictEqual(stored, []);
        // The window's place is saved as it closes.
        yield* Effect.promise(() => app.close());
        const saved = yield* fs.readFileString(
          path.join(profile, "J3 Bots Development", "desktop.json"),
        );
        assert.include(saved, `"server":null`);
        assert.include(saved, `"window":{`);
      }),
    120_000,
  );
});
