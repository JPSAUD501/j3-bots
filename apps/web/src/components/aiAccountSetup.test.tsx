// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { AccountChanges } from "@j3-bots/client-runtime";
import {
  type AccountEdits,
  noAccountEdits,
  setUpAccounts,
} from "@j3-bots/client-runtime/presentation";
import { AiSessionProvider } from "@j3-bots/client-runtime/react";
import { type EngineStatus, ModelId, ProviderId } from "@j3-bots/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTestRoot } from "../app/testRoot";
import { sampleProviderActions } from "../gallery/sampleSource";
import { SetUpAccountRow } from "./AiAccountSetup";
import { useWebAiConnect } from "./AiConnect";
import type { ProviderActions } from "./ProviderFix";

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const work = ProviderId.make("claude-work");

/** A server that sets accounts up, with a Claude account the operator added. */
const engine: EngineStatus = {
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers: [
    {
      id: work,
      name: "Work",
      harness: "claude-code",
      status: { _tag: "ready" },
      models: [{ id: ModelId.make("model"), name: "Model" }],
      usage: [],
      setup: {
        enabled: true,
        added: true,
        binaryPath: null,
        launchArguments: "",
        home: "/srv/j3/providers/claude-work",
      },
    },
  ],
};

/** What the form asked of the server, in order. */
let asked: Array<{ readonly providerId: ProviderId; readonly changes?: AccountChanges }>;
const actions: ProviderActions = {
  ...sampleProviderActions,
  setUpAccount: (providerId, changes) => {
    asked.push({ providerId, changes });
    return Promise.resolve(true);
  },
  removeAccount: (providerId) => {
    asked.push({ providerId });
    return Promise.resolve(true);
  },
};

function Row({ edits }: { readonly edits: AccountEdits }) {
  const ai = useWebAiConnect({ engine, connect: { _tag: "server" }, actions });
  const [entry] = setUpAccounts(engine);
  if (entry === undefined) throw new Error("No account set up");
  return (
    <ul>
      <SetUpAccountRow ai={ai} entry={entry} actions={actions} stale={false} defaultEdits={edits} />
    </ul>
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createTestRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const shown = (edits: AccountEdits) =>
  act(() =>
    root.render(
      <AiSessionProvider>
        <Row edits={edits} />
      </AiSessionProvider>,
    ),
  );

/** Presses the button named `name`, anywhere on the page: a confirmation opens over it. */
const press = async (name: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`No ${name} button`);
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
};

describe("an account's Advanced settings", () => {
  it("saves only what changed, saying first that it restarts the account", async () => {
    shown({ ...noAccountEdits, binaryPath: " /opt/work/bin/claude " });
    expect(document.body.textContent).toContain("Saving restarts this account");
    await press("Save");
    expect(asked).toEqual([{ providerId: work, changes: { binaryPath: "/opt/work/bin/claude" } }]);
  });

  it("sends nothing while a field is one the server would refuse", async () => {
    shown({ ...noAccountEdits, binaryPath: "claude" });
    await press("Save");
    expect(asked).toEqual([]);
    // The field says what is wrong with it to a screen reader too.
    const field = container.querySelector("input[aria-invalid]");
    const described = field?.getAttribute("aria-describedby")?.split(" ") ?? [];
    const said = described.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(said.join(" ")).toContain("full path");
  });

  it("removes an added account only once the operator confirms", async () => {
    shown(noAccountEdits);
    await press("Remove account");
    expect(asked).toEqual([]);
    await press("Remove");
    expect(asked).toEqual([{ providerId: work }]);
  });
});
