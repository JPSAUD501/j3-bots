// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { ReceivedUpdateStatus } from "@j3-bots/contracts";
import type { ReleaseNumber, WhatsNewRelease } from "@j3-bots/i18n/whats-new";
import { Cell } from "../Store.ts";
import type { ServerUpdateView } from "../update/ServerUpdate.ts";
import { makeWhatsNew, releaseName, type WhatsNewSeen, whatsNewStore } from "./WhatsNew.ts";

const words = { en: "Sample", "pt-BR": "Exemplo" };
const release = (version: ReleaseNumber): WhatsNewRelease => ({
  version,
  entries: [{ title: words, body: words }],
});
const catalog = [release("0.14.0"), release("0.16.0"), release("0.15.0")];

const running = (version: string): ServerUpdateView => {
  const status: ReceivedUpdateStatus = {
    api: 1,
    current: { version, channel: "stable" },
    channel: "stable",
    available: null,
    waitingForStable: false,
    refused: null,
    lastCheck: null,
    canUpdate: { _tag: "able" },
    state: { _tag: "idle" },
    run: null,
    lastResult: null,
  };
  return { _tag: "status", status };
};

/** What's new over a server's updates and a device's storage, both fakes. */
const harness = (kept: string | null = null) => {
  const server = new Cell<ServerUpdateView>({ _tag: "unread" });
  const storage = { value: kept };
  const whatsNew = makeWhatsNew({
    server,
    catalog,
    store: whatsNewStore({
      get: () => storage.value,
      set: (value) => {
        storage.value = value;
      },
    }),
  });
  const shown = () => whatsNew.view.get().releases.map((each) => each.version);
  return { server, storage, whatsNew, shown, mark: () => whatsNew.view.get().mark };
};

const seen = (value: WhatsNewSeen) => JSON.stringify(value);

describe("What's new", () => {
  it("shows the releases up to the server's, newest first, and marks the newest", () => {
    const { server, shown, mark } = harness();
    assert.deepStrictEqual(shown(), []);
    server.set(running("0.15.0"));
    assert.deepStrictEqual(shown(), ["0.15.0", "0.14.0"]);
    assert.strictEqual(mark(), "0.15.0");
  });

  it("drops the mark once opened, and brings it back when the server updates to a release with entries", () => {
    const { server, whatsNew, mark } = harness();
    server.set(running("0.14.0"));
    whatsNew.open();
    assert.isNull(mark());
    // A patch with nothing new of its own leaves it opened.
    server.set(running("0.14.1"));
    assert.isNull(mark());
    server.set(running("0.15.0"));
    assert.strictEqual(mark(), "0.15.0");
  });

  it("reads a release candidate or a nightly as the release it leads to", () => {
    const { server, shown, mark } = harness();
    server.set(running("0.16.0-rc.1"));
    assert.deepStrictEqual(shown(), ["0.16.0", "0.15.0", "0.14.0"]);
    assert.strictEqual(mark(), "0.16.0");
    server.set(running("0.15.1-nightly.20261127.3"));
    assert.deepStrictEqual(shown(), ["0.15.0", "0.14.0"]);
  });

  it("shows nothing for a server older than every release with entries", () => {
    const { server, shown, mark } = harness();
    server.set(running("0.13.0"));
    assert.deepStrictEqual(shown(), []);
    assert.isNull(mark());
  });

  it("keeps the server it last saw and what was opened across launches", () => {
    const first = harness();
    first.server.set(running("0.15.0"));
    first.whatsNew.open();
    const again = harness(first.storage.value);
    // Before this launch has read the server, it shows what it saw last.
    assert.deepStrictEqual(again.shown(), ["0.15.0", "0.14.0"]);
    assert.isNull(again.mark());
    // The server updated while the app was closed.
    again.server.set(running("0.16.0"));
    assert.strictEqual(again.mark(), "0.16.0");
  });

  it("reads what the device kept that it cannot decode as nothing seen", () => {
    const { shown } = harness("not json");
    assert.deepStrictEqual(shown(), []);
    assert.deepStrictEqual(harness(seen({ server: "0.14.0", opened: null })).shown(), ["0.14.0"]);
  });

  it("names a release by its minor version unless it is a patch", () => {
    assert.strictEqual(releaseName("0.14.0"), "0.14");
    assert.strictEqual(releaseName("0.14.1"), "0.14.1");
    assert.strictEqual(releaseName("1.0.0"), "1.0");
  });
});
