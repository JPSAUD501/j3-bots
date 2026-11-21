// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/** Made once the page has taken what only it reads off the address, such as a pairing link's code. */
export const makeRouter = () => createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
