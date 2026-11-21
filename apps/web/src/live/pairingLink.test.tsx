// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import { PairingCode } from "@j3-bots/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { Pairing } from "../components/Pairing";
import { linkedCodeAfter, takePairingCode } from "./pairingLink";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const SERVER = "http://192.0.2.10:3737";
const CODE = PairingCode.make("7KQ2M9XH4D");

/** The history a page's address bar is replaced through. */
const tab = () => {
  const replaceState = vi.fn<History["replaceState"]>();
  return { history: { state: { key: "router" }, replaceState }, replaceState };
};

describe("a page opened from a pairing link", () => {
  it("takes the code and leaves for the app's root, given whole, at once", () => {
    const { history, replaceState } = tab();
    expect(takePairingCode(`${SERVER}/pair#${CODE}`, history)).toBe(CODE);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ key: "router" }, "", `${SERVER}/`);
  });

  it("leaves /pair with no code when it is not a whole link", () => {
    for (const href of [
      `${SERVER}/pair#not-a-code`,
      `${SERVER}/pair`,
      `${SERVER}/pair?details=true#${CODE}`,
    ]) {
      const { history, replaceState } = tab();
      expect(takePairingCode(href, history)).toBeNull();
      expect(replaceState).toHaveBeenCalledExactlyOnceWith({ key: "router" }, "", `${SERVER}/`);
    }
  });

  it("leaves any other address alone", () => {
    for (const href of [
      `${SERVER}/`,
      `${SERVER}/#${CODE}`,
      `${SERVER}/bots/x#section`,
      `${SERVER}//pair#${CODE}`,
    ]) {
      const { history, replaceState } = tab();
      expect(takePairingCode(href, history)).toBeNull();
      expect(replaceState).not.toHaveBeenCalled();
    }
  });
  it("starts the pairing screen with the code and the server, and waits for Pair", () => {
    const onPair = vi.fn<Parameters<typeof Pairing>[0]["onPair"]>();
    const html = renderToStaticMarkup(
      <Pairing
        reason="new"
        defaultName="Safari on iPhone"
        initialCode={CODE}
        address={SERVER}
        onPair={onPair}
      />,
    );
    expect(html).toContain(`value="${CODE}"`);
    expect(html).toContain(`Server: ${SERVER}`);
    expect(onPair).not.toHaveBeenCalled();
  });
});

describe("a pairing link's code as the browser connects", () => {
  const after = (states: ReadonlyArray<ConnectionState>) =>
    states.reduce<PairingCode | null>(linkedCodeAfter, CODE);

  it("stays for the pairing screen when a stored credential is refused", () => {
    expect(
      after([
        { _tag: "starting" },
        { _tag: "connecting", attempt: 1 },
        { _tag: "unpaired", reason: "signed-out" },
      ]),
    ).toBe(CODE);
  });

  it("is dropped once the browser is connected, already paired", () => {
    expect(
      after([
        { _tag: "starting" },
        { _tag: "connecting", attempt: 1 },
        { _tag: "connected" },
        { _tag: "unpaired", reason: "signed-out" },
      ]),
    ).toBeNull();
  });
});
