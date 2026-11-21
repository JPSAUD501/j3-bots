// SPDX-License-Identifier: AGPL-3.0-or-later
import { PairingCode } from "@j3-bots/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { Pairing } from "../components/Pairing";
import { takePairingCode } from "./pairingLink";

// The stored preferences follow the system's theme, which a page reads off `window` as it loads.
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({ appearance: "system", language: "en", theme: "light" }),
}));

const SERVER = "http://192.0.2.10:3737";
const CODE = PairingCode.make("7KQ2M9XH4D");

/** The page opened at `href`, and the history its address bar is replaced through. */
const opened = (href: string) => {
  const url = new URL(href);
  const replaceState = vi.fn<History["replaceState"]>();
  return {
    location: { href, hash: url.hash, pathname: url.pathname, search: url.search },
    history: { state: { key: "router" }, replaceState },
    replaceState,
  };
};

describe("a page opened from a pairing link", () => {
  it("takes the code and clears it from the address bar at once", () => {
    const page = opened(`${SERVER}/#pair=${CODE}`);
    expect(takePairingCode(page.location, page.history)).toBe(CODE);
    expect(page.replaceState).toHaveBeenCalledExactlyOnceWith({ key: "router" }, "", "/");
  });

  it("clears a pair fragment that is not a whole link, with no code", () => {
    for (const href of [
      `${SERVER}/#pair=not-a-code`,
      `${SERVER}/bots/x?details=true#pair=${CODE}`,
    ]) {
      const page = opened(href);
      expect(takePairingCode(page.location, page.history)).toBeNull();
      const url = new URL(href);
      expect(page.replaceState).toHaveBeenCalledExactlyOnceWith(
        { key: "router" },
        "",
        `${url.pathname}${url.search}`,
      );
    }
  });

  it("leaves any other address alone", () => {
    for (const href of [`${SERVER}/`, `${SERVER}/bots/x#section`]) {
      const page = opened(href);
      expect(takePairingCode(page.location, page.history)).toBeNull();
      expect(page.replaceState).not.toHaveBeenCalled();
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
