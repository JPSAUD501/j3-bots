// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { deferred } from "./deferred";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

interface DialogProps {
  readonly open: boolean;
}

function Dialog({ open }: DialogProps) {
  return <p>{open ? "open" : "closing"}</p>;
}

it("fetches a closed dialog's code only once it opens, and keeps it mounted to close", async () => {
  let loads = 0;
  const { Component } = deferred(
    () => {
      loads += 1;
      return Promise.resolve(Dialog);
    },
    (props: DialogProps) => props.open,
  );

  await act(async () => root.render(<Component open={false} />));
  expect(loads).toBe(0);
  expect(container.textContent).toBe("");

  await act(async () => root.render(<Component open={true} />));
  expect(loads).toBe(1);
  expect(container.textContent).toBe("open");

  await act(async () => root.render(<Component open={false} />));
  expect(container.textContent).toBe("closing");
  expect(loads).toBe(1);
});

it("fetches the code again when it is next wanted, after a fetch that failed", async () => {
  let loads = 0;
  const { Component, preload } = deferred((): Promise<typeof Dialog> => {
    loads += 1;
    return loads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(Dialog);
  });

  await expect(preload()).rejects.toThrow("offline");
  await act(async () => root.render(<Component open={true} />));
  expect(loads).toBe(2);
  expect(container.textContent).toBe("open");
});
