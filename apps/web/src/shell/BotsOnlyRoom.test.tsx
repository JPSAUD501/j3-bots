// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { AiSessionProvider } from "@j3-bots/client-runtime/react";
import type { RosterItemKey } from "@j3-bots/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ids } from "../gallery/sample";
import { useSampleSource } from "../gallery/sampleSource";
import { Shell } from "./Shell";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));
vi.mock("../lib/motion", () => ({ reducedMotion: () => true, play: () => null }));

const rowButton = <button type="button" />;

/** The app on one room of the sample team. */
function Harness({ selected }: { selected: RosterItemKey }) {
  const source = useSampleSource();
  return (
    <AiSessionProvider>
      <Shell
        data={source.data}
        intents={source.intents}
        browser={source.browser}
        keyboard={false}
        navigation={{
          selected,
          detailsOpen: false,
          select: () => {},
          setDetailsOpen: () => {},
          browser: null,
          setBrowser: () => {},
          rowLink: () => rowButton,
          pair: null,
          openPair: () => {},
          pairLink: () => rowButton,
        }}
      />
    </AiSessionProvider>
  );
}

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

const show = (roomId: typeof ids.fairStands) =>
  act(() => root.render(<Harness selected={{ _tag: "room", roomId }} />));

const labelled = (label: string) =>
  [...container.querySelectorAll("button")].filter(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );

describe("a room of bots only", () => {
  it("shows where the composer would be that only bots talk there, and offers nothing to say", () => {
    show(ids.fairStands);
    expect(container.textContent).toContain("Read-only · Only bots talk here");
    expect(container.querySelector("[contenteditable='plaintext-only']")).toBeNull();
    expect(labelled("React")).toHaveLength(0);
    expect(labelled("Reply")).toHaveLength(0);
    // The bots' own reactions still show, as something to read.
    const pill = labelled("👍, 1 reaction");
    expect(pill.map((button) => button.getAttribute("aria-disabled"))).toEqual(["true"]);
  });

  it("leaves a room the operator is in as it was", () => {
    show(ids.newsletter);
    expect(container.textContent).not.toContain("Only bots talk here");
    expect(container.querySelector("[contenteditable='plaintext-only']")).not.toBeNull();
  });
});
