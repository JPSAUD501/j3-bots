// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { LocalExportResult, MovedAway } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MovedAwayScreen, MoveToAnotherServer } from "./LocalMode";

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

// The first screen's stage animates its bots, which happy-dom cannot run;
// what it says is all these tests read.
vi.mock("../onboarding/parts", async (actual) => ({
  ...(await actual<typeof import("../onboarding/parts")>()),
  FirstScreen: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PASSPHRASE = "a long passphrase for the move";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/** A button anywhere on the page, the dialog's included, by its text. */
const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`No ${name} button`);
  return found;
};

const field = (label: string) => {
  const found = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = found === undefined ? null : document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No ${label} field`);
  return input;
};

/** Types `value` into `input` as a person would, so React sees the change. */
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const problem = () => document.querySelector('[role="alert"]')?.textContent ?? "";

/** Opens the dialog, types both passphrases, and asks to export. */
const exportWith = async (passphrase: string, again: string) => {
  await act(async () => {
    type(field("Passphrase for the secrets"), passphrase);
    type(field("The same passphrase again"), again);
  });
  await act(async () => {
    button("Choose where to save").click();
  });
};

describe("moving the bots on this computer to another server", () => {
  it("asks the app only once both passphrases are long enough and the same", async () => {
    const onMove = vi.fn((_: Redacted.Redacted<string>) =>
      Promise.resolve<LocalExportResult>({ _tag: "cancelled" }),
    );
    act(() => root.render(<MoveToAnotherServer onMove={onMove} />));
    await act(async () => {
      button("Move to another server").click();
    });
    expect(document.body.textContent).toContain("It can’t be recovered");

    await exportWith("short", "short");
    expect(problem()).toBe("The passphrase needs at least 8 characters.");
    await exportWith(PASSPHRASE, `${PASSPHRASE}!`);
    expect(problem()).toBe("The two passphrases differ.");
    expect(onMove).not.toHaveBeenCalled();

    // Closing the save dialog leaves the form as it was, with nothing to say.
    await exportWith(PASSPHRASE, PASSPHRASE);
    expect(onMove).toHaveBeenCalledOnce();
    expect(Redacted.value(onMove.mock.calls[0]?.[0] ?? Redacted.make(""))).toBe(PASSPHRASE);
    expect(problem()).toBe("");
    expect(button("Choose where to save")).toBeDefined();
  });

  it("says the export failed, in its own words, and lets the operator try again", async () => {
    const onMove = vi.fn(() =>
      Promise.resolve<LocalExportResult>({
        _tag: "failed",
        reason: "There is no room left on the disk.",
      }),
    );
    act(() => root.render(<MoveToAnotherServer onMove={onMove} />));
    await act(async () => {
      button("Move to another server").click();
    });
    await exportWith(PASSPHRASE, PASSPHRASE);
    expect(problem()).toBe(
      "The export failed, and your bots run here again. There is no room left on the disk.",
    );
    await exportWith(PASSPHRASE, PASSPHRASE);
    expect(onMove).toHaveBeenCalledTimes(2);
  });
});

describe("the screen once the bots moved", () => {
  const moved = (leftOut: MovedAway["leftOut"]): MovedAway => ({
    file: "/exports/j3-bots-export.tar.gz",
    at: DateTime.makeUnsafe("2026-11-20T10:00:00Z"),
    leftOut,
  });
  const nothing = { links: 0, names: 0, firstNames: [], attachmentsMissing: 0 };
  const render = (value: MovedAway) =>
    act(() =>
      root.render(
        <MovedAwayScreen
          moved={value}
          onConnect={() => Promise.resolve(false)}
          onRunHere={() => Promise.resolve(false)}
          onDelete={() => Promise.resolve(false)}
        />,
      ),
    );

  it("says what the export left out, and that deleting the data here loses the secrets", async () => {
    render(
      moved({
        ...nothing,
        secrets: "old-vault",
        names: 21,
        firstNames: Array.from({ length: 20 }, (_, i) => `bots/ana/files/a\\${i}`),
      }),
    );
    expect(document.body.textContent).toContain("Left out of the file:");
    expect(document.body.textContent).toContain("they’re in an old vault");
    expect(document.body.textContent).toContain("21 files whose name has a \\ in it");
    expect(document.body.textContent).toContain("bots/ana/files/a\\19");
    expect(document.body.textContent).toContain("and 1 more");
    await act(async () => {
      button("Delete the data on this computer").click();
    });
    expect(document.body.textContent).toContain("deleting the data here loses them for good");
  });

  it("says nothing was left out by saying nothing of it", async () => {
    render(moved(nothing));
    expect(document.body.textContent).not.toContain("Left out of the file:");
    await act(async () => {
      button("Delete the data on this computer").click();
    });
    expect(document.body.textContent).not.toContain("loses them for good");
  });
});
