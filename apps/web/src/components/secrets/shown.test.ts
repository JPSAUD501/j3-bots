// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { hideShownLater, type Page, SHOWN_FOR } from "./shown";

/** A page whose visibility the test sets. */
const page = () => {
  const target = new EventTarget();
  let visibilityState: DocumentVisibilityState = "visible";
  const fake: Page = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    page: fake,
    setVisibility: (state: DocumentVisibilityState) => {
      visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
};

describe("a value shown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides itself thirty seconds after it was shown, and not before", () => {
    const hide = vi.fn();
    hideShownLater(hide, page().page);
    vi.advanceTimersByTime(SHOWN_FOR - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
    expect(SHOWN_FOR).toBe(30_000);
  });

  it("hides as soon as the page is hidden", () => {
    const hide = vi.fn();
    const { page: watched, setVisibility } = page();
    hideShownLater(hide, watched);
    setVisibility("visible");
    expect(hide).not.toHaveBeenCalled();
    setVisibility("hidden");
    expect(hide).toHaveBeenCalledOnce();
  });

  it("stops watching once hidden another way", () => {
    const hide = vi.fn();
    const { page: watched, setVisibility } = page();
    const stop = hideShownLater(hide, watched);
    stop();
    setVisibility("hidden");
    vi.advanceTimersByTime(SHOWN_FOR);
    expect(hide).not.toHaveBeenCalled();
  });
});
