// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { createTestRoot } from "../app/testRoot";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useFocusAfterStop } from "./focusAfterStop";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A pane's heading, a Stop while there is work, and another control. */
function Pane({ working }: { readonly working: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const stopRef = useFocusAfterStop(heading);
  return (
    <section>
      <h2 ref={heading} tabIndex={-1}>
        Details
      </h2>
      {working && (
        <button ref={stopRef} type="button">
          Stop
        </button>
      )}
      <button type="button">Edit</button>
    </section>
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createTestRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`No ${name} button`);
  return found;
};

describe("the focus once the work a Stop ends is over", () => {
  it("moves to the heading when it was on the Stop", () => {
    act(() => root.render(<Pane working />));
    button("Stop").focus();

    act(() => root.render(<Pane working={false} />));

    expect(document.activeElement?.textContent).toBe("Details");
  });

  it("stays where the operator moved it", () => {
    act(() => root.render(<Pane working />));
    button("Edit").focus();

    act(() => root.render(<Pane working={false} />));

    expect(document.activeElement).toBe(button("Edit"));
  });
});
