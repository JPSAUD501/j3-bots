// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { renderLinkHandlerEntry } from "./desktopEntry.ts";

const execOf = (entry: string) => entry.split("\n").find((line) => line.startsWith("Exec="));

describe("the Linux handler of the app's links", () => {
  it("starts the program with its arguments as given, whatever they hold, and the link last", () => {
    const entry = renderLinkHandlerEntry({
      name: "J3 Bots",
      command: ["/opt/J3 Bots/j3-bots", '/srv/50% "$HOME"\\app', "--no-sandbox"],
      scheme: "j3bots",
    });
    assert.strictEqual(
      execOf(entry),
      String.raw`Exec="/opt/J3 Bots/j3-bots" "/srv/50%% \\"\\$HOME\\"\\\\app" --no-sandbox %U`,
    );
    assert.include(entry, "MimeType=x-scheme-handler/j3bots;\n");
    assert.include(entry, "NoDisplay=true\n");
  });

  it("leaves a word unquoted where it can, for an xdg-open that does not unquote", () => {
    const entry = renderLinkHandlerEntry({
      name: "J3 Bots",
      command: ["/home/dev/.bin/electron", "/home/dev/j3-bots/apps/desktop", "--no-sandbox"],
      scheme: "j3bots-dev",
    });
    assert.strictEqual(
      execOf(entry),
      "Exec=/home/dev/.bin/electron /home/dev/j3-bots/apps/desktop --no-sandbox %U",
    );
  });
});
