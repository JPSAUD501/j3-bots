// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { AiAccount } from "@j3-bots/client-runtime/presentation";
import { type AiIntents, AiSessionProvider, useAiConnect } from "@j3-bots/client-runtime/react";
import {
  type EngineStatus,
  type HarnessCopy,
  ModelId,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const noCopy: HarnessCopy = {
  source: "none",
  version: null,
  latest: null,
  installable: true,
  task: null,
  last: null,
};

const provider = (
  account: AiAccount,
  status: ProviderStatus["status"],
  copy?: HarnessCopy,
): ProviderStatus => ({
  id: ProviderId.make(account),
  name: account,
  harness: account,
  status,
  models: [{ id: ModelId.make("model"), name: "Model", efforts: [] }],
  usage: [],
  ...(copy === undefined ? {} : { copy }),
});

const engineWith = (claude: ProviderStatus): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers: [claude, provider("codex", { _tag: "sign-in-required", command: "connect" })],
});

const notInstalled = { _tag: "unavailable", checking: false, reason: "not-installed" } as const;
const missing = engineWith(provider("claude-code", notInstalled, noCopy));
const downloading = engineWith(
  provider("claude-code", notInstalled, {
    ...noCopy,
    task: { _tag: "downloading", receivedBytes: 10, totalBytes: 100 },
  }),
);
const signedOut = engineWith(
  provider("claude-code", { _tag: "sign-in-required", command: "connect" }),
);

/** What the screen asked of the server, in order. */
let asked: Array<string>;
/** Whether the server refuses the next downloads. */
let refuseDownload: boolean;
const intents: AiIntents = {
  signIn: (account) => void asked.push(`sign-in ${account}`),
  cancelSignIn: (account) => void asked.push(`cancel ${account}`),
  download: (account) => {
    asked.push(`download ${account}`);
    return Promise.resolve(!refuseDownload);
  },
  cancelDownload: () => Promise.resolve(true),
  recheck: () => Promise.resolve(true),
};

/** A screen that connects the accounts, with the open account's button and the way to the other. */
function Screen({ engine, name = "" }: { readonly engine: EngineStatus; readonly name?: string }) {
  const ai = useAiConnect({
    facts: { engine, locations: null, signIns: new Map() },
    place: "here",
    intents,
    initial: "claude-code",
  });
  return (
    <>
      <output>{ai.opened?.queued === true ? "queued" : "idle"}</output>
      {ai.opened?.action != null && (
        <button type="button" onClick={ai.opened.act}>
          {`act${name}`}
        </button>
      )}
      {ai.opened === null && (
        <button type="button" onClick={() => ai.open("claude-code")}>
          claude
        </button>
      )}
      <button type="button" onClick={() => ai.open("codex")}>
        other
      </button>
    </>
  );
}

/** One app with a screen at a time: the first run's step, then the conversation after Create. */
function App({
  engine,
  screen,
}: {
  readonly engine: EngineStatus;
  readonly screen: "step" | "conversation" | "both";
}) {
  return (
    <AiSessionProvider>
      {screen !== "conversation" && <Screen key="step" engine={engine} />}
      {screen !== "step" && <Screen key="conversation" engine={engine} name="-2" />}
    </AiSessionProvider>
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  refuseDownload = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const press = async (name: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`No ${name} button`);
  // Past the request's answer, which a press may wait on.
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
};
const shown = (engine: EngineStatus) => act(() => root.render(<Screen engine={engine} />));

const checking = engineWith(provider("claude-code", { _tag: "unavailable", checking: true }));
const queuedShown = () => container.querySelector("output")?.textContent;

describe("a sign-in asked for before the account can take one", () => {
  it("asks for the download, waits through it, and opens the sign-in once, the moment it can", async () => {
    shown(missing);
    await press("act");
    expect(asked).toEqual(["download claude-code"]);
    expect(queuedShown()).toBe("queued");

    shown(downloading);
    expect(asked).toEqual(["download claude-code"]);

    shown(signedOut);
    expect(asked).toEqual(["download claude-code", "sign-in claude-code"]);
    // The same state again, as another report of it, starts nothing more.
    shown({ ...signedOut });
    expect(asked).toEqual(["download claude-code", "sign-in claude-code"]);
    expect(queuedShown()).toBe("idle");
  });

  it("asks for the download itself when the account, pressed while still being checked, turns out to need one", async () => {
    shown(checking);
    await press("act");
    expect(asked).toEqual([]);

    await act(async () => {
      root.render(<Screen engine={missing} />);
      await Promise.resolve();
    });
    expect(asked).toEqual(["download claude-code"]);
    // Another report of the same state asks nothing again.
    shown({ ...missing });
    expect(asked).toEqual(["download claude-code"]);
  });

  it("is forgotten when the operator turns to the other account, while the download goes on", async () => {
    shown(downloading);
    await press("act");
    await press("other");

    shown(signedOut);
    expect(asked).toEqual([]);
  });

  it("is forgotten when the download fails, so nothing opens by surprise later", async () => {
    shown(downloading);
    await press("act");
    shown(
      engineWith(
        provider("claude-code", notInstalled, {
          ...noCopy,
          last: { _tag: "failed", reason: "unreachable", at: DateTime.makeUnsafe(0) },
        }),
      ),
    );
    shown(signedOut);
    expect(asked).toEqual([]);
  });

  it("is given up, and says so, when the server does not take the download", async () => {
    refuseDownload = true;
    shown(missing);
    await press("act");
    expect(asked).toEqual(["download claude-code"]);
    expect(queuedShown()).toBe("idle");

    shown(signedOut);
    expect(asked).toEqual(["download claude-code"]);
  });
});

describe("what one app remembers of connecting an AI, from screen to screen", () => {
  const app = (engine: EngineStatus, screen: "step" | "conversation" | "both") =>
    act(() => root.render(<App engine={engine} screen={screen} />));

  it("keeps a sign-in asked for in the first run through creating the bot, and opens it from the conversation", async () => {
    app(downloading, "step");
    await press("claude");
    await press("act");

    // Create: the step goes, the conversation comes, on the account that was picked.
    app(downloading, "conversation");
    expect(queuedShown()).toBe("queued");

    app(signedOut, "conversation");
    expect(asked).toEqual(["sign-in claude-code"]);
  });

  it("starts the sign-in once when two screens show the account", async () => {
    app(downloading, "both");
    await press("claude");
    await press("act");

    app(signedOut, "both");
    expect(asked).toEqual(["sign-in claude-code"]);
  });
});
