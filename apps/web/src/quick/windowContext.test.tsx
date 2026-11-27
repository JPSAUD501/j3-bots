// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { WindowContext } from "@j3-bots/client-runtime";
import type {
  LookingAtSettings,
  QuickAccessCue,
  QuickAccessPicture,
} from "@j3-bots/desktop-bridge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useWindowContext, type WindowSource } from "./windowContext";
import { WindowChips } from "./WindowChips";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const BROWSER = { app: "Example Browser", title: "Invoice 2026-031 · Paid" } as const;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** The desktop app as quick access's page meets it, its cues sent by hand. */
function fakeApp(answers: { picture: QuickAccessPicture; screen?: LookingAtSettings["screen"] }) {
  const listeners = new Set<(cue: QuickAccessCue) => void>();
  const asked: Array<number> = [];
  const app: WindowSource = {
    askScreenAccess: () =>
      Promise.resolve({
        reach: "window",
        title: true,
        pictureByDefault: false,
        screen: answers.screen ?? "needed",
      }),
    quickAccess: {
      onCue: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      picture: (opening) => {
        asked.push(opening);
        return Promise.resolve(answers.picture);
      },
    },
  };
  const cue = (sent: QuickAccessCue) =>
    act(() => {
      for (const listener of listeners) listener(sent);
    });
  return { app, cue, asked };
}

let sent: Array<WindowContext | undefined>;
function Harness({ app }: { app: WindowSource }) {
  const window = useWindowContext(app);
  return (
    <>
      {window.view !== null && (
        <WindowChips view={window.view} intents={window.intents} botName="Wren" />
      )}
      <button
        type="button"
        data-send
        onClick={() => void window.context().then((context) => sent.push(context))}
      />
    </>
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const button = (label: string) => {
  const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`No button "${label}"`);
  return found;
};
const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};
const send = () => {
  const found = container.querySelector<HTMLElement>("[data-send]");
  if (found === null) throw new Error("No way to send");
  return press(found);
};
const seen = (
  opening: number,
  picture: "available" | "needs-permission" | "none",
  byDefault = false,
) =>
  ({
    _tag: "seen",
    opening,
    window: { lookingAt: BROWSER, picture, pictureByDefault: byDefault },
  }) as const;

describe("the window quick access opened over", () => {
  it("sends exactly what its chips show, and nothing once its chip is taken off", async () => {
    const { app, cue } = fakeApp({ picture: { _tag: "failed" } });
    act(() => root.render(<Harness app={app} />));
    cue({ _tag: "open", opening: 1 });
    cue(seen(1, "available"));
    expect(container.textContent).toContain("Example Browser · Invoice 2026-031 · Paid");

    await send();
    expect(sent.at(-1)).toEqual({ lookingAt: BROWSER });

    await press(button("Don’t send Example Browser"));
    expect(container.querySelector("[role=group]")).toBeNull();
    await send();
    expect(sent.at(-1)).toBeUndefined();
  });

  it("takes a picture only when it is turned on, and sends it with the window", async () => {
    const { app, cue, asked } = fakeApp({
      picture: { _tag: "taken", bytes: JPEG, mediaType: "image/jpeg", width: 2, height: 2 },
    });
    act(() => root.render(<Harness app={app} />));
    cue({ _tag: "open", opening: 3 });
    cue(seen(3, "available"));
    expect(asked).toEqual([]);

    await press(button("Add a picture of Example Browser"));
    expect(asked).toEqual([3]);
    await send();
    const context = sent.at(-1);
    expect(context?.lookingAt).toEqual(BROWSER);
    expect(context?.picture?.name).toBe("Picture of Example Browser.jpg");
    expect(
      new Uint8Array(await (context?.picture?.body.arrayBuffer() ?? new ArrayBuffer(0))),
    ).toEqual(JPEG);

    await press(button("Don’t send the picture"));
    await send();
    expect(sent.at(-1)).toEqual({ lookingAt: BROWSER });
  });

  it("takes one at once when the operator asked for it on every message", async () => {
    const { app, cue, asked } = fakeApp({
      picture: { _tag: "taken", bytes: JPEG, mediaType: "image/jpeg", width: 2, height: 2 },
    });
    act(() => root.render(<Harness app={app} />));
    cue({ _tag: "open", opening: 1 });
    cue(seen(1, "available", true));
    expect(asked).toEqual([1]);
    await send();
    expect(sent.at(-1)?.picture).toBeDefined();
  });

  it("forgets what an earlier showing read, and what quick access read once it goes", async () => {
    const { app, cue } = fakeApp({ picture: { _tag: "failed" } });
    act(() => root.render(<Harness app={app} />));
    cue({ _tag: "open", opening: 1 });
    cue({ _tag: "open", opening: 2 });
    // Read for the showing before: late, it is not this one's.
    cue(seen(1, "available"));
    expect(container.querySelector("[role=group]")).toBeNull();

    cue(seen(2, "available"));
    expect(container.querySelector("[role=group]")).not.toBeNull();
    cue({ _tag: "leave" });
    expect(container.querySelector("[role=group]")).toBeNull();
    await send();
    expect(sent.at(-1)).toBeUndefined();
  });

  it("asks for macOS's permission before a picture, in plain words, and sends none until then", async () => {
    const { app, cue, asked } = fakeApp({ picture: { _tag: "failed" }, screen: "needed" });
    act(() => root.render(<Harness app={app} />));
    cue({ _tag: "open", opening: 1 });
    cue(seen(1, "needs-permission"));

    await press(button("Add a picture of Example Browser"));
    expect(container.textContent).toContain("Screen Recording");
    expect(asked).toEqual([]);
    await send();
    expect(sent.at(-1)).toEqual({ lookingAt: BROWSER });

    const allow = [...container.querySelectorAll("button")].find(
      (found) => found.textContent === "Allow in System Settings",
    );
    if (allow === undefined) throw new Error("No way to allow it");
    await press(allow);
    // Not allowed yet: the ask goes, the picture stays off.
    expect(container.textContent).not.toContain("Screen Recording");
    expect(asked).toEqual([]);
  });
});
