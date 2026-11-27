// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { PromptOption } from "@j3-bots/client-runtime/presentation";
import { ConnectorPrompt } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type RenderedPrompt, usePromptPicker } from "./PromptPicker";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const prompt: PromptOption = {
  ...Schema.decodeSync(ConnectorPrompt)({
    connectorId: "conn_sampleplanner0000",
    name: "weekly-plan",
    title: "Weekly plan",
    description: "Plans the week.",
    arguments: [{ name: "team", title: null, description: "", required: true }],
  }),
  connector: "Planner",
};

let picker: ReturnType<typeof usePromptPicker> | null = null;
const written: Array<string> = [];
let answer: (rendered: RenderedPrompt) => void = () => {};

function Harness() {
  const field = useRef<HTMLDivElement>(null);
  const current = usePromptPicker({
    draftKey: "draft",
    value: "/",
    onValueChange: (text) => written.push(text),
    field,
    menu: {
      load: () => Promise.resolve([prompt]),
      render: () =>
        new Promise<RenderedPrompt>((resolve) => {
          answer = resolve;
        }),
    },
  });
  useEffect(() => {
    picker = current;
  });
  return <div ref={field} />;
}

const shown = () => {
  if (picker === null) throw new Error("No prompt picker");
  return picker;
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  written.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  picker = null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("the prompt menu", () => {
  it("writes nothing when the server answers a prompt the operator cancelled", async () => {
    act(() => root.render(<Harness />));
    act(() => shown().pick(prompt));
    act(() => shown().fill("team", "Design"));
    act(() => shown().use());
    act(() => shown().cancel());
    await act(async () => answer({ text: "Plan the week for Design.", cut: false }));

    expect(written).toEqual([]);
    expect(shown().chosen).toBeNull();
  });

  it("writes the prompt into the draft once the server answers", async () => {
    act(() => root.render(<Harness />));
    act(() => shown().pick(prompt));
    act(() => shown().fill("team", "Design"));
    act(() => shown().use());
    await act(async () => answer({ text: "Plan the week for Design.", cut: false }));

    expect(written).toEqual(["Plan the week for Design."]);
  });
});
