// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import type { SecretRequestValues } from "@j3-bots/client-runtime/presentation";
import {
  BotId,
  EntryId,
  EntryOrder,
  type SecretRequestEntry,
  secretRequestFieldId,
} from "@j3-bots/contracts";
import { at } from "@j3-bots/client-runtime/testing";
import * as Redacted from "effect/Redacted";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SecretRequestCard } from "./SecretRequestCard";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const signIn: SecretRequestEntry = {
  _tag: "secret-request",
  id: EntryId.make("sign-in"),
  order: EntryOrder.make(1),
  createdAt: at("2026-11-27T10:00:00Z"),
  author: { _tag: "bot", botId: BotId.make("mira") },
  label: "Sign in to Mail",
  reason: "To sort your invoices.",
  url: null,
  placeholder: null,
  fields: [
    { id: secretRequestFieldId(0), label: "Email", placeholder: null, masked: false },
    { id: secretRequestFieldId(1), label: "Password", placeholder: null, masked: true },
  ],
  delivery: "file",
  status: "pending",
};

let root: Root;
let container: HTMLElement;
let sent: Array<SecretRequestValues>;

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

const show = (entry: SecretRequestEntry) =>
  act(() =>
    root.render(
      <SecretRequestCard
        entry={entry}
        onProvide={(answer) => sent.push(answer)}
        onDecline={() => {}}
      />,
    ),
  );

const field = (label: string) => {
  const found = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = found === undefined ? null : document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No ${label} field`);
  return input;
};

/** Types `value` into `input` as a person would, so React sees the change. */
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Enter in `input`: its form's submission. */
const enter = (input: HTMLInputElement) =>
  act(() => {
    input.form?.requestSubmit();
  });

describe("a secret request card with several values", () => {
  it("moves Enter to the next empty value, then sends them all at once", () => {
    show(signIn);
    act(() => type(field("Email"), "someone@example.com"));

    enter(field("Email"));
    expect(document.activeElement).toBe(field("Password"));
    expect(sent).toEqual([]);

    act(() => type(field("Password"), "example-password"));
    enter(field("Password"));

    expect(sent).toHaveLength(1);
    const [answer] = sent;
    expect(answer?._tag).toBe("provide-fields");
    if (answer?._tag !== "provide-fields") return;
    expect(Object.entries(answer.values).map(([id, value]) => [id, Redacted.value(value)])).toEqual(
      [
        ["field-1", "someone@example.com"],
        ["field-2", "example-password"],
      ],
    );
    // What was typed does not stay in the card.
    expect([field("Email").value, field("Password").value]).toEqual(["", ""]);
  });

  it("shows the email as typed and hides the password until asked to show it", () => {
    show(signIn);
    expect(field("Email").type).toBe("text");
    expect(field("Password").type).toBe("password");

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show Password"]');
    act(() => toggle?.click());

    expect(field("Password").type).toBe("text");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("lets a password manager fill a sign-in, and keeps it away from a single key", () => {
    show(signIn);
    expect(field("Email").autocomplete).toBe("username");
    expect(field("Password").autocomplete).toBe("current-password");

    show({ ...signIn, id: EntryId.make("token"), label: "npm token", fields: [] });
    expect(field("npm token").autocomplete).toBe("off");
  });
});
